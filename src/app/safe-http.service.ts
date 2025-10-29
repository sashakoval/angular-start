import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom, throwError, Observable } from 'rxjs';
import { catchError, timeout, retry, delay } from 'rxjs/operators';

/**
 * Безопасный сервис для работы с HttpClient в многопоточных сценариях
 * 
 * Решает проблемы:
 * - Необработанные ошибки в catch блоках
 * - Падения при большом количестве параллельных запросов
 * - Проблемы с Zone.js и асинхронными ошибками
 */
@Injectable({
  providedIn: 'root'
})
export class SafeHttpService {
  constructor(private http: HttpClient) {}

  /**
   * Безопасный HTTP GET запрос с правильной обработкой ошибок
   * 
   * @param url URL для запроса
   * @param options Дополнительные опции (timeout, retry и т.д.)
   */
  async get<T>(
    url: string,
    options: {
      timeout?: number;
      retries?: number;
      retryDelay?: number;
    } = {}
  ): Promise<T> {
    const {
      timeout: timeoutMs = 30000,
      retries = 0,
      retryDelay = 1000
    } = options;

    try {
      let request$: Observable<T> = this.http.get<T>(url);

      // Добавляем retry если указано
      if (retries > 0) {
        request$ = request$.pipe(
          retry({ count: retries, delay: retryDelay })
        );
      }

      // Добавляем timeout
      request$ = request$ = request$.pipe(timeout(timeoutMs));

      // ВАЖНО: Обрабатываем ошибки в RxJS pipeline до преобразования в Promise
      request$ = request$.pipe(
        catchError(error => {
          // Логируем ошибку ДО пробрасывания
          console.error(`HTTP GET Error for ${url}:`, error);
          
          // Преобразуем ошибку в более информативную
          const errorMessage = error?.message || error?.error || 'Unknown error';
          return throwError(() => new Error(`HTTP Request failed: ${errorMessage}`));
        })
      );

      // Используем firstValueFrom вместо toPromise() для корректной обработки ошибок
      return await firstValueFrom(request$);
    } catch (error) {
      // Теперь ошибка гарантированно будет перехвачена здесь
      console.error(`Request to ${url} failed:`, error);
      throw error;
    }
  }

  /**
   * Безопасные параллельные запросы с ограничением количества одновременных
   * 
   * @param urls Массив URL для запросов
   * @param maxConcurrent Максимальное количество одновременных запросов
   * @param options Опции для каждого запроса
   */
  async getParallel<T>(
    urls: string[],
    maxConcurrent: number = 10,
    options: {
      timeout?: number;
      retries?: number;
      retryDelay?: number;
    } = {}
  ): Promise<Array<{ url: string; data: T | null; error: Error | null }>> {
    const results: Array<{ url: string; data: T | null; error: Error | null }> = [];

    // Обрабатываем запросы батчами
    for (let i = 0; i < urls.length; i += maxConcurrent) {
      const batch = urls.slice(i, i + maxConcurrent);
      
      // Создаем промисы для батча с индивидуальной обработкой ошибок
      const batchPromises = batch.map(async (url) => {
        try {
          const data = await this.get<T>(url, options);
          return { url, data, error: null };
        } catch (error) {
          // Каждая ошибка обрабатывается индивидуально
          console.error(`Failed to fetch ${url}:`, error);
          return {
            url,
            data: null,
            error: error instanceof Error ? error : new Error(String(error))
          };
        }
      });

      // Используем allSettled для получения всех результатов, включая ошибки
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          // Обрабатываем даже ошибки в самих промисах
          console.error(`Promise rejected for ${batch[index]}:`, result.reason);
          results.push({
            url: batch[index],
            data: null,
            error: result.reason instanceof Error 
              ? result.reason 
              : new Error(String(result.reason))
          });
        }
      });

      // Небольшая задержка между батчами для снижения нагрузки
      if (i + maxConcurrent < urls.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }

  /**
   * Безопасные параллельные запросы с использованием forkJoin
   * 
   * @param urls Массив URL для запросов
   * @param options Опции для каждого запроса
   */
  async getParallelForkJoin<T>(
    urls: string[],
    options: {
      timeout?: number;
      retries?: number;
      retryDelay?: number;
    } = {}
  ): Promise<Array<{ url: string; data: T | null; error: Error | null }>> {
    const { forkJoin } = await import('rxjs');
    
    try {
      // Создаем массив Observable с обработкой ошибок для каждого
      const requests = urls.map(url => {
        let request$: Observable<T> = this.http.get<T>(url);

        if (options.timeout) {
          request$ = request$.pipe(timeout(options.timeout));
        }

        if (options.retries && options.retries > 0) {
          request$ = request$.pipe(
            retry({ count: options.retries, delay: options.retryDelay || 1000 })
          );
        }

        // ВАЖНО: Каждый Observable обрабатывает свои ошибки
        return request$.pipe(
          catchError(error => {
            console.error(`HTTP Error for ${url}:`, error);
            // Возвращаем null вместо ошибки, чтобы forkJoin не прерывался
            // В реальном проекте можно вернуть значение по умолчанию
            return throwError(() => ({ url, error }));
          })
        );
      });

      // Используем forkJoin для параллельного выполнения
      const results = await firstValueFrom(forkJoin(requests));
      
      // Преобразуем результаты в нужный формат
      return results.map((data, index) => ({
        url: urls[index],
        data,
        error: null
      }));
    } catch (error) {
      // Обрабатываем ошибку forkJoin
      console.error('Error in forkJoin:', error);
      
      // Если хотя бы один запрос упал, forkJoin выбрасывает ошибку
      // В этом случае делаем запросы индивидуально
      return this.getParallel<T>(urls, 10, options);
    }
  }

  /**
   * Безопасный POST запрос
   */
  async post<T>(
    url: string,
    body: any,
    options: {
      timeout?: number;
      retries?: number;
      retryDelay?: number;
    } = {}
  ): Promise<T> {
    const {
      timeout: timeoutMs = 30000,
      retries = 0,
      retryDelay = 1000
    } = options;

    try {
      let request$: Observable<T> = this.http.post<T>(url, body);

      if (retries > 0) {
        request$ = request$.pipe(
          retry({ count: retries, delay: retryDelay })
        );
      }

      request$ = request$.pipe(timeout(timeoutMs));

      request$ = request$.pipe(
        catchError(error => {
          console.error(`HTTP POST Error for ${url}:`, error);
          const errorMessage = error?.message || error?.error || 'Unknown error';
          return throwError(() => new Error(`HTTP POST failed: ${errorMessage}`));
        })
      );

      return await firstValueFrom(request$);
    } catch (error) {
      console.error(`POST request to ${url} failed:`, error);
      throw error;
    }
  }
}
