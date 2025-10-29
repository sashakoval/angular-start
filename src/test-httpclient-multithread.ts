import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, forkJoin, from, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

/**
 * Тестовый файл для диагностики проблемы с HttpClient в многопоточности
 * 
 * ПРОБЛЕМА: Приложение падает без ошибок при использовании HttpClient
 * с большим количеством параллельных запросов
 * 
 * ВОЗМОЖНЫЕ ПРИЧИНЫ:
 * 1. Zone.js не всегда корректно обрабатывает ошибки в worker threads
 * 2. HttpClient может выбрасывать необработанные ошибки за пределами RxJS
 * 3. Проблемы с памятью при большом количестве одновременных запросов
 * 4. Неправильная обработка ошибок в async операциях
 */

@Injectable({
  providedIn: 'root'
})
export class HttpClientTestService {
  constructor(private http: HttpClient) {}

  /**
   * ПРОБЛЕМНЫЙ КОД - может падать без ошибок
   */
  async problematicMethod(url: string): Promise<any> {
    try {
      // ПРОБЛЕМА: ошибки могут не перехватываться catch блоком
      return await this.http.get(url).toPromise();
    } catch (error) {
      // Ошибка может не доходить сюда
      console.error('Error caught:', error);
      throw error;
    }
  }

  /**
   * ИСПРАВЛЕННЫЙ КОД 1: Использование RxJS операторов для обработки ошибок
   */
  async safeMethod1(url: string): Promise<any> {
    try {
      return await this.http.get(url).pipe(
        catchError(error => {
          // ВАЖНО: Обрабатываем ошибку в RxJS pipeline
          console.error('HTTP Error in pipeline:', error);
          // Возвращаем ошибку как Observable, чтобы она была обработана
          return throwError(() => new Error(`HTTP Error: ${error.message || error}`));
        })
      ).toPromise();
    } catch (error) {
      // Теперь ошибка должна доходить сюда
      console.error('Error caught in catch block:', error);
      throw error;
    }
  }

  /**
   * ИСПРАВЛЕННЫЙ КОД 2: Использование firstValueFrom/lastValueFrom (Angular 12+)
   */
  async safeMethod2(url: string): Promise<any> {
    const { firstValueFrom } = await import('rxjs');
    
    try {
      return await firstValueFrom(
        this.http.get(url).pipe(
          catchError(error => {
            console.error('HTTP Error:', error);
            return throwError(() => error);
          })
        )
      );
    } catch (error) {
      console.error('Error caught:', error);
      throw error;
    }
  }

  /**
   * ИСПРАВЛЕННЫЙ КОД 3: Использование forkJoin для управления параллельными запросами
   */
  async safeParallelRequests(urls: string[]): Promise<any[]> {
    const { firstValueFrom } = await import('rxjs');
    
    try {
      // Создаем массив Observable с обработкой ошибок
      const requests = urls.map(url =>
        this.http.get(url).pipe(
          catchError(error => {
            console.error(`Error fetching ${url}:`, error);
            // Возвращаем значение по умолчанию или пробрасываем ошибку
            return throwError(() => error);
          })
        )
      );

      // Используем forkJoin для параллельного выполнения
      return await firstValueFrom(forkJoin(requests));
    } catch (error) {
      console.error('Error in parallel requests:', error);
      throw error;
    }
  }

  /**
   * ИСПРАВЛЕННЫЙ КОД 4: Использование Promise.allSettled для отслеживания всех результатов
   */
  async safeParallelRequestsWithSettled(urls: string[]): Promise<any[]> {
    const { firstValueFrom } = await import('rxjs');
    
    // Оборачиваем каждый запрос в Promise с обработкой ошибок
    const promises = urls.map(async (url) => {
      try {
        return await firstValueFrom(
          this.http.get(url).pipe(
            catchError(error => {
              console.error(`Error fetching ${url}:`, error);
              return throwError(() => error);
            })
          )
        );
      } catch (error) {
        // ВАЖНО: Логируем ошибку и возвращаем null или выбрасываем
        console.error(`Failed to fetch ${url}:`, error);
        return null; // или throw error если нужно прервать выполнение
      }
    });

    // Используем allSettled для получения всех результатов, включая ошибки
    const results = await Promise.allSettled(promises);
    
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        console.error(`Promise rejected for ${urls[index]}:`, result.reason);
        return null;
      }
    });
  }
}

/**
 * ПРИМЕР ИСПОЛЬЗОВАНИЯ В КОНСОЛЬНОМ ПРИЛОЖЕНИИ С 50 ПОТОКАМИ
 */
async function testWith50Threads() {
  const { HttpClient, HttpXhrBackend } = await import('@angular/common/http');
  const { BrowserXhr } = await import('@angular/common/http');
  const httpClient = new HttpClient(new HttpXhrBackend({ build: () => new BrowserXhr() }));
  const service = new HttpClientTestService(httpClient);

  const testUrl = 'https://jsonplaceholder.typicode.com/posts/1';
  const threads = 50;

  console.log(`Starting ${threads} parallel requests...`);

  // ВАРИАНТ 1: Использование Promise.all (может падать)
  try {
    const promises = Array.from({ length: threads }, () =>
      service.safeMethod2(testUrl)
    );
    const results = await Promise.all(promises);
    console.log('All requests completed:', results.length);
  } catch (error) {
    console.error('Error with Promise.all:', error);
  }

  // ВАРИАНТ 2: Использование Promise.allSettled (рекомендуется)
  const promises2 = Array.from({ length: threads }, () =>
    service.safeMethod2(testUrl).catch(error => {
      console.error('Individual request failed:', error);
      return null;
    })
  );
  
  const results2 = await Promise.allSettled(promises2);
  const successCount = results2.filter(r => r.status === 'fulfilled').length;
  const failureCount = results2.filter(r => r.status === 'rejected').length;
  
  console.log(`Completed: ${successCount} success, ${failureCount} failures`);

  // ВАРИАНТ 3: Использование ограниченного количества параллельных запросов
  const batchSize = 10; // Ограничиваем количество одновременных запросов
  const results3: any[] = [];
  
  for (let i = 0; i < threads; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, threads - i) }, () =>
      service.safeMethod2(testUrl).catch(error => {
        console.error('Request failed:', error);
        return null;
      })
    );
    
    const batchResults = await Promise.allSettled(batch);
    results3.push(...batchResults);
    
    // Небольшая задержка между батчами
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`Batch processing completed: ${results3.length} results`);
}

// Экспорт для использования
export { testWith50Threads };
