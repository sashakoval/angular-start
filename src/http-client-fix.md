# Решение проблемы с падением HttpClient в многопоточности

## Проблема
При использовании HttpClient в консольном приложении с большим количеством параллельных запросов (50+ потоков) приложение падает без выброса ошибок, даже в catch блоках.

## Причины

### 1. Zone.js и асинхронные ошибки
В Angular ошибки могут возникать вне контекста Zone.js, что делает их невидимыми для обычных catch блоков.

### 2. Необработанные Promise rejections
При использовании `toPromise()` ошибки могут не перехватываться правильно.

### 3. Превышение лимитов соединений
Большое количество одновременных HTTP-запросов может превысить лимиты браузера/Node.js.

## Решения

### ✅ РЕШЕНИЕ 1: Использование firstValueFrom/lastValueFrom вместо toPromise()

```typescript
import { firstValueFrom } from 'rxjs';

// Вместо:
await httpClient.get(url).toPromise();

// Используйте:
await firstValueFrom(
  httpClient.get(url).pipe(
    catchError(error => {
      console.error('HTTP Error:', error);
      return throwError(() => error);
    })
  )
);
```

### ✅ РЕШЕНИЕ 2: Обработка ошибок в RxJS pipeline

**ВАЖНО:** Всегда обрабатывайте ошибки в RxJS pipeline до преобразования в Promise:

```typescript
const result = await firstValueFrom(
  httpClient.get(url).pipe(
    catchError(error => {
      // Обработка ошибки ДО преобразования в Promise
      console.error('Error in pipeline:', error);
      return throwError(() => new Error(`Request failed: ${error.message}`));
    })
  )
);
```

### ✅ РЕШЕНИЕ 3: Использование Promise.allSettled вместо Promise.all

```typescript
// ПЛОХО - может падать при первой ошибке:
const results = await Promise.all(promises);

// ХОРОШО - обрабатывает все результаты:
const results = await Promise.allSettled(promises);
results.forEach((result, index) => {
  if (result.status === 'fulfilled') {
    console.log('Success:', result.value);
  } else {
    console.error('Failed:', result.reason);
  }
});
```

### ✅ РЕШЕНИЕ 4: Ограничение параллельных запросов

```typescript
async function makeRequestsWithLimit(urls: string[], maxConcurrent = 10) {
  const results: any[] = [];
  
  for (let i = 0; i < urls.length; i += maxConcurrent) {
    const batch = urls.slice(i, i + maxConcurrent);
    const batchPromises = batch.map(url =>
      firstValueFrom(
        httpClient.get(url).pipe(
          catchError(error => {
            console.error(`Error fetching ${url}:`, error);
            return throwError(() => error);
          })
        )
      )
    );
    
    const batchResults = await Promise.allSettled(batchPromises);
    results.push(...batchResults);
  }
  
  return results;
}
```

### ✅ РЕШЕНИЕ 5: Глобальная обработка необработанных ошибок

Добавьте в начало вашего приложения:

```typescript
// Обработка необработанных Promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Здесь можно добавить логирование или отправку в monitoring
});

// Обработка необработанных исключений
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Для браузера:
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled Promise Rejection:', event.reason);
  event.preventDefault(); // Предотвращаем вывод в консоль по умолчанию
});
```

### ✅ РЕШЕНИЕ 6: Настройка HttpClient для ограничения параллельных запросов

```typescript
import { HttpBackend, HttpXhrBackend } from '@angular/common/http';
import { HttpClient } from '@angular/common/http';

// Создайте настроенный HttpClient с ограничениями
const httpClient = new HttpClient(
  new HttpXhrBackend({
    build: () => {
      const xhr = new XMLHttpRequest();
      // Настройки для увеличения timeout
      // xhr.timeout = 30000;
      return xhr;
    }
  })
);

// Или используйте interceptor для ограничения параллельных запросов
```

## Пример правильного использования

```typescript
import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom, forkJoin } from 'rxjs';
import { catchError } from 'rxjs/operators';

@Injectable()
export class SafeHttpService {
  constructor(private http: HttpClient) {}

  async makeRequest(url: string): Promise<any> {
    try {
      return await firstValueFrom(
        this.http.get(url).pipe(
          catchError(error => {
            // ВАЖНО: Обрабатываем ошибку в pipeline
            console.error('HTTP Error:', error);
            throw error; // Пробрасываем для обработки выше
          })
        )
      );
    } catch (error) {
      // Теперь ошибка гарантированно будет перехвачена
      console.error('Request failed:', error);
      throw error;
    }
  }

  async makeParallelRequests(urls: string[], maxConcurrent = 10): Promise<any[]> {
    const results: any[] = [];
    
    for (let i = 0; i < urls.length; i += maxConcurrent) {
      const batch = urls.slice(i, i + maxConcurrent);
      
      const batchPromises = batch.map(url =>
        this.makeRequest(url).catch(error => {
          // Обрабатываем каждую ошибку индивидуально
          console.error(`Failed to fetch ${url}:`, error);
          return null; // или другое значение по умолчанию
        })
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          console.error(`Promise rejected for ${batch[index]}:`, result.reason);
          results.push(null);
        }
      });
      
      // Небольшая задержка между батчами для снижения нагрузки
      if (i + maxConcurrent < urls.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return results;
  }
}
```

## Дополнительные рекомендации

1. **Используйте retry логику** для обработки временных сбоев:
```typescript
import { retry, delay } from 'rxjs/operators';

this.http.get(url).pipe(
  retry({ count: 3, delay: 1000 }),
  catchError(error => throwError(() => error))
)
```

2. **Мониторинг и логирование**: Всегда логируйте ошибки для диагностики

3. **Timeout для запросов**: Устанавливайте timeout для предотвращения зависаний:
```typescript
import { timeout } from 'rxjs/operators';

this.http.get(url).pipe(
  timeout(30000), // 30 секунд
  catchError(error => throwError(() => error))
)
```

4. **Тестирование**: Тестируйте с различным количеством параллельных запросов
