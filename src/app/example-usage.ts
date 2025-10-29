import { Component, OnInit } from '@angular/core';
import { SafeHttpService } from './safe-http.service';

/**
 * Пример правильного использования SafeHttpService
 * для работы с 50+ параллельными запросами
 */
@Component({
  selector: 'app-example',
  template: '<div>Check console for results</div>'
})
export class ExampleComponent implements OnInit {
  constructor(private safeHttp: SafeHttpService) {}

  async ngOnInit() {
    await this.exampleUsage();
  }

  /**
   * Пример 1: Одиночный безопасный запрос
   */
  async exampleSingleRequest() {
    try {
      const data = await this.safeHttp.get('https://jsonplaceholder.typicode.com/posts/1', {
        timeout: 5000,
        retries: 3,
        retryDelay: 1000
      });
      console.log('Success:', data);
    } catch (error) {
      // Ошибка гарантированно будет перехвачена
      console.error('Request failed:', error);
    }
  }

  /**
   * Пример 2: 50 параллельных запросов с ограничением (10 одновременно)
   */
  async example50ParallelRequests() {
    const baseUrl = 'https://jsonplaceholder.typicode.com/posts';
    const urls = Array.from({ length: 50 }, (_, i) => `${baseUrl}/${i + 1}`);

    console.log(`Starting 50 parallel requests with max 10 concurrent...`);

    const results = await this.safeHttp.getParallel(urls, 10, {
      timeout: 10000,
      retries: 2,
      retryDelay: 500
    });

    // Анализ результатов
    const successCount = results.filter(r => r.error === null).length;
    const errorCount = results.filter(r => r.error !== null).length;

    console.log(`Completed: ${successCount} success, ${errorCount} errors`);

    // Обработка ошибок
    results.forEach(result => {
      if (result.error) {
        console.error(`Failed: ${result.url}`, result.error);
      }
    });

    return results;
  }

  /**
   * Пример 3: Использование в консольном приложении (без компонента)
   */
  static async consoleAppExample(safeHttp: SafeHttpService) {
    const urls = Array.from(
      { length: 50 },
      (_, i) => `https://jsonplaceholder.typicode.com/posts/${i + 1}`
    );

    console.log('Starting 50 requests...');

    const results = await safeHttp.getParallel(urls, 10);

    const summary = {
      total: results.length,
      success: results.filter(r => r.error === null).length,
      failed: results.filter(r => r.error !== null).length
    };

    console.log('Summary:', summary);

    return results;
  }

  /**
   * Основной пример использования
   */
  async exampleUsage() {
    try {
      // Пример 1: Один запрос
      await this.exampleSingleRequest();

      // Небольшая задержка
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Пример 2: 50 параллельных запросов
      await this.example50ParallelRequests();
    } catch (error) {
      console.error('Fatal error in example:', error);
    }
  }
}

/**
 * Пример использования в Node.js консольном приложении
 */
export async function nodeConsoleExample() {
  // Инициализация для Node.js (если используется)
  // import { HttpClient, HttpXhrBackend } from '@angular/common/http';
  // import { BrowserXhr } from '@angular/common/http';
  
  // const httpClient = new HttpClient(new HttpXhrBackend({ build: () => new BrowserXhr() }));
  // const safeHttp = new SafeHttpService(httpClient);
  
  // await ExampleComponent.consoleAppExample(safeHttp);
}
