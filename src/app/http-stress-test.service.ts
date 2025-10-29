import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';

export interface RequestResult {
  id: number;
  success: boolean;
  data?: any;
  error?: string;
  duration: number;
}

@Injectable({
  providedIn: 'root'
})
export class HttpStressTestService {
  
  constructor(private http: HttpClient) { }

  /**
   * Демонстрация проблемы: множественные параллельные HTTP запросы
   * Это эквивалент .NET консольного приложения с 50 потоками
   * 
   * В .NET проблемы возникают когда:
   * 1. Используется async void вместо async Task
   * 2. Не обрабатываются исключения в Task
   * 3. Используется .Result или .Wait() вызывая deadlock
   * 4. Thread pool исчерпан из-за blocking calls
   */
  makeParallelRequests(count: number = 50, url: string = 'https://jsonplaceholder.typicode.com/posts/1'): Observable<RequestResult[]> {
    console.log(`Starting ${count} parallel HTTP requests...`);
    
    const requests: Observable<RequestResult>[] = [];
    
    for (let i = 0; i < count; i++) {
      const startTime = Date.now();
      
      // Каждый запрос обёрнут в обработчик ошибок
      const request$ = this.http.get(url).pipe(
        map(data => ({
          id: i + 1,
          success: true,
          data: data,
          duration: Date.now() - startTime
        } as RequestResult)),
        
        // КРИТИЧЕСКИ ВАЖНО: обработка ошибок для каждого запроса
        // Без этого один failed запрос убьёт весь Observable stream
        catchError((error: HttpErrorResponse) => {
          console.error(`Request ${i + 1} failed:`, error.message);
          return of({
            id: i + 1,
            success: false,
            error: error.message,
            duration: Date.now() - startTime
          } as RequestResult);
        })
      );
      
      requests.push(request$);
    }
    
    // forkJoin ждёт завершения всех запросов
    // Это аналог Task.WhenAll() в .NET
    return forkJoin(requests).pipe(
      tap(results => {
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
        
        console.log(`=== Results ===`);
        console.log(`Total: ${results.length}`);
        console.log(`Successful: ${successful}`);
        console.log(`Failed: ${failed}`);
        console.log(`Average duration: ${avgDuration.toFixed(2)}ms`);
      }),
      
      // Глобальная обработка ошибок
      catchError(error => {
        console.error('Fatal error in parallel requests:', error);
        return of([]);
      })
    );
  }

  /**
   * НЕПРАВИЛЬНЫЙ СПОСОБ (анти-паттерн)
   * Это демонстрирует что НЕ нужно делать
   */
  makeParallelRequestsWrong(count: number = 50): void {
    // ❌ ПЛОХО: fire-and-forget pattern
    // Ошибки могут быть не пойманы
    for (let i = 0; i < count; i++) {
      this.http.get('https://jsonplaceholder.typicode.com/posts/1').subscribe(
        data => console.log(`Request ${i} success`),
        // ❌ Даже с обработкой ошибок, unsubscribe может произойти
        // до завершения всех запросов
        error => console.error(`Request ${i} failed`, error)
      );
    }
    
    // ❌ ПРОБЛЕМА: метод завершается до окончания всех запросов
    // В консольном приложении это приведёт к завершению программы
    // до окончания асинхронных операций
  }

  /**
   * Контролируемая параллельность с пакетной обработкой
   * Полезно когда нужно ограничить количество одновременных запросов
   */
  makeParallelRequestsWithBatching(
    totalRequests: number = 100,
    batchSize: number = 10,
    url: string = 'https://jsonplaceholder.typicode.com/posts/1'
  ): Observable<RequestResult[]> {
    const allResults: RequestResult[] = [];
    
    const processBatch = (startIdx: number): Observable<RequestResult[]> => {
      const endIdx = Math.min(startIdx + batchSize, totalRequests);
      const batchRequests: Observable<RequestResult>[] = [];
      
      for (let i = startIdx; i < endIdx; i++) {
        const startTime = Date.now();
        const request$ = this.http.get(url).pipe(
          map(data => ({
            id: i + 1,
            success: true,
            data: data,
            duration: Date.now() - startTime
          } as RequestResult)),
          catchError((error: HttpErrorResponse) => of({
            id: i + 1,
            success: false,
            error: error.message,
            duration: Date.now() - startTime
          } as RequestResult))
        );
        
        batchRequests.push(request$);
      }
      
      return forkJoin(batchRequests);
    };
    
    // Обрабатываем пакеты последовательно
    let currentBatch = 0;
    const totalBatches = Math.ceil(totalRequests / batchSize);
    
    const processNext = (): Observable<RequestResult[]> => {
      if (currentBatch >= totalBatches) {
        return of(allResults);
      }
      
      console.log(`Processing batch ${currentBatch + 1}/${totalBatches}`);
      
      return processBatch(currentBatch * batchSize).pipe(
        tap(results => {
          allResults.push(...results);
          currentBatch++;
        }),
        map(() => allResults)
      );
    };
    
    return processNext();
  }
}

/*
ТИПИЧНЫЕ ПРОБЛЕМЫ В .NET КОНСОЛЬНЫХ ПРИЛОЖЕНИЯХ:

1. ASYNC VOID - самая частая причина необработанных исключений:
   ❌ async void DoWork() { ... }  // Исключения не могут быть пойманы
   ✅ async Task DoWork() { ... }  // Правильно

2. FIRE-AND-FORGET без ожидания:
   ❌ Task.Run(() => DoWork());  // Программа может завершиться до окончания
   ✅ await Task.Run(() => DoWork());  // Правильно

3. DEADLOCK из-за блокирующих вызовов:
   ❌ var result = httpClient.GetAsync(url).Result;  // Deadlock в UI context
   ✅ var result = await httpClient.GetAsync(url);  // Правильно

4. НЕТ ГЛОБАЛЬНОГО ОБРАБОТЧИКА ИСКЛЮЧЕНИЙ:
   В Program.cs добавьте:
   
   AppDomain.CurrentDomain.UnhandledException += (sender, e) =>
   {
       Console.WriteLine($"Unhandled exception: {e.ExceptionObject}");
   };
   
   TaskScheduler.UnobservedTaskException += (sender, e) =>
   {
       Console.WriteLine($"Unobserved exception: {e.Exception}");
       e.SetObserved();
   };

5. НЕ ОЖИДАЮТСЯ ВСЕ ЗАДАЧИ ПЕРЕД ЗАВЕРШЕНИЕМ:
   ❌ 
   static void Main()
   {
       for (int i = 0; i < 50; i++)
           Task.Run(() => DoWork());
   }  // Программа завершится немедленно
   
   ✅
   static async Task Main()
   {
       var tasks = new List<Task>();
       for (int i = 0; i < 50; i++)
           tasks.Add(Task.Run(() => DoWork()));
       await Task.WhenAll(tasks);
   }

6. ИСЧЕРПАНИЕ THREAD POOL:
   - ServicePointManager.DefaultConnectionLimit = 100; // Увеличьте лимит
   - Используйте HttpClientFactory вместо singleton HttpClient
   - Добавьте retry policy с exponential backoff

7. НЕПРАВИЛЬНАЯ КОНФИГУРАЦИЯ HTTPCLIENT:
   ✅ Правильный singleton:
   
   private static readonly HttpClient client = new HttpClient
   {
       Timeout = TimeSpan.FromSeconds(30),
       MaxResponseContentBufferSize = 1024 * 1024 * 10 // 10MB
   };
   
   ✅ Или используйте IHttpClientFactory (рекомендуется):
   
   services.AddHttpClient("MyClient")
       .SetHandlerLifetime(TimeSpan.FromMinutes(5))
       .AddPolicyHandler(GetRetryPolicy());
*/
