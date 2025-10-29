/**
 * Глобальный обработчик ошибок для приложения
 * 
 * ВАЖНО: Добавьте этот код в начало вашего приложения (main.ts)
 * или в точку входа вашего консольного приложения
 * 
 * Это поможет перехватывать необработанные ошибки, которые не попадают
 * в catch блоки при работе с HttpClient в многопоточности
 */

/**
 * Настройка глобальной обработки ошибок для Node.js приложения
 */
export function setupNodeErrorHandlers() {
  // Обработка необработанных Promise rejections
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('=== UNHANDLED PROMISE REJECTION ===');
    console.error('Reason:', reason);
    console.error('Promise:', promise);
    console.error('Stack:', reason?.stack || 'No stack trace');
    
    // Здесь можно добавить отправку в систему мониторинга
    // sendToMonitoring(reason);
    
    // ВНИМАНИЕ: Не завершайте процесс в продакшене автоматически
    // process.exit(1);
  });

  // Обработка необработанных исключений
  process.on('uncaughtException', (error: Error) => {
    console.error('=== UNCAUGHT EXCEPTION ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    
    // ВНИМАНИЕ: В продакшене обычно завершают процесс
    // В разработке можно продолжить работу для отладки
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  });

  console.log('✅ Global error handlers initialized for Node.js');
}

/**
 * Настройка глобальной обработки ошибок для браузера
 */
export function setupBrowserErrorHandlers() {
  // Обработка необработанных Promise rejections в браузере
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    console.error('=== UNHANDLED PROMISE REJECTION (Browser) ===');
    console.error('Reason:', event.reason);
    console.error('Promise:', event.promise);
    
    // Предотвращаем вывод в консоль по умолчанию, так как мы уже логируем
    event.preventDefault();
    
    // Здесь можно отправить в систему мониторинга
    // sendToMonitoring(event.reason);
  });

  // Обработка глобальных ошибок JavaScript
  window.addEventListener('error', (event: ErrorEvent) => {
    console.error('=== GLOBAL ERROR (Browser) ===');
    console.error('Message:', event.message);
    console.error('Source:', event.filename, 'Line:', event.lineno);
    console.error('Error:', event.error);
    
    // Предотвращаем вывод в консоль по умолчанию
    event.preventDefault();
  });

  console.log('✅ Global error handlers initialized for Browser');
}

/**
 * Универсальная инициализация (определяет среду автоматически)
 */
export function setupGlobalErrorHandlers() {
  // Проверяем, находимся ли мы в Node.js окружении
  if (typeof process !== 'undefined' && process.on) {
    setupNodeErrorHandlers();
  }

  // Проверяем, находимся ли мы в браузере
  if (typeof window !== 'undefined') {
    setupBrowserErrorHandlers();
  }
}

/**
 * Пример использования в main.ts (Angular):
 * 
 * import { enableProdMode } from '@angular/core';
 * import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
 * import { setupGlobalErrorHandlers } from './app/global-error-handler';
 * 
 * // Добавить перед bootstrapModule
 * setupGlobalErrorHandlers();
 * 
 * platformBrowserDynamic().bootstrapModule(AppModule)
 *   .catch(err => console.error(err));
 */

/**
 * Пример использования в Node.js консольном приложении:
 * 
 * import { setupGlobalErrorHandlers } from './app/global-error-handler';
 * 
 * // Добавить в самое начало файла
 * setupGlobalErrorHandlers();
 * 
 * // Ваш код приложения
 */
