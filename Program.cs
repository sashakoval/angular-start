using System;
using System.Net.Http;
using System.Threading.Tasks;
using System.Threading;
using System.Collections.Concurrent;

namespace HttpClientMultiThreadDemo
{
    class Program
    {
        // Проблемный подход - статический HttpClient без правильной конфигурации
        private static readonly HttpClient _httpClient = new HttpClient();
        
        // Улучшенный подход - HttpClient с правильной конфигурацией
        private static readonly HttpClient _configuredHttpClient = CreateConfiguredHttpClient();
        
        // Счетчик для отслеживания активных запросов
        private static int _activeRequests = 0;
        private static readonly object _lockObject = new object();
        
        // Коллекция для хранения результатов
        private static readonly ConcurrentBag<string> _results = new ConcurrentBag<string>();
        private static readonly ConcurrentBag<Exception> _exceptions = new ConcurrentBag<Exception>();

        static async Task Main(string[] args)
        {
            Console.WriteLine("Демонстрация проблем HttpClient в многопоточном окружении");
            Console.WriteLine("=========================================================");
            
            // Настройка глобального обработчика необработанных исключений
            AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;
            TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
            
            Console.WriteLine("\n1. Тестирование проблемного подхода...");
            await TestProblematicApproach();
            
            Console.WriteLine("\n2. Тестирование улучшенного подхода...");
            await TestImprovedApproach();
            
            Console.WriteLine("\nНажмите любую клавишу для завершения...");
            Console.ReadKey();
        }

        private static HttpClient CreateConfiguredHttpClient()
        {
            var httpClient = new HttpClient();
            
            // Настройка таймаутов
            httpClient.Timeout = TimeSpan.FromSeconds(30);
            
            // Настройка заголовков по умолчанию
            httpClient.DefaultRequestHeaders.Add("User-Agent", "MultiThreadDemo/1.0");
            
            return httpClient;
        }

        // Проблемный подход - может привести к падению приложения
        private static async Task TestProblematicApproach()
        {
            const int threadCount = 50;
            const int requestsPerThread = 10;
            
            var tasks = new Task[threadCount];
            
            for (int i = 0; i < threadCount; i++)
            {
                int threadId = i;
                tasks[i] = Task.Run(async () =>
                {
                    try
                    {
                        for (int j = 0; j < requestsPerThread; j++)
                        {
                            await MakeProblematicRequest(threadId, j);
                        }
                    }
                    catch (Exception ex)
                    {
                        _exceptions.Add(ex);
                        Console.WriteLine($"Исключение в потоке {threadId}: {ex.Message}");
                    }
                });
            }
            
            try
            {
                await Task.WhenAll(tasks);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Общее исключение: {ex.Message}");
            }
            
            Console.WriteLine($"Проблемный подход завершен. Исключений: {_exceptions.Count}");
        }

        private static async Task MakeProblematicRequest(int threadId, int requestId)
        {
            try
            {
                Interlocked.Increment(ref _activeRequests);
                
                // Используем httpbin.org для тестирования
                string url = $"https://httpbin.org/delay/1?thread={threadId}&request={requestId}";
                
                // Потенциально проблемный вызов без правильной обработки исключений
                var response = await _httpClient.GetAsync(url);
                var content = await response.Content.ReadAsStringAsync();
                
                _results.Add($"Thread {threadId}, Request {requestId}: Success");
                
                Console.Write(".");
            }
            catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
            {
                _exceptions.Add(ex);
                Console.WriteLine($"Таймаут в потоке {threadId}, запрос {requestId}");
            }
            catch (HttpRequestException ex)
            {
                _exceptions.Add(ex);
                Console.WriteLine($"HTTP ошибка в потоке {threadId}, запрос {requestId}: {ex.Message}");
            }
            catch (Exception ex)
            {
                _exceptions.Add(ex);
                Console.WriteLine($"Неожиданная ошибка в потоке {threadId}, запрос {requestId}: {ex.Message}");
            }
            finally
            {
                Interlocked.Decrement(ref _activeRequests);
            }
        }

        // Улучшенный подход с правильной обработкой ошибок
        private static async Task TestImprovedApproach()
        {
            const int threadCount = 50;
            const int requestsPerThread = 5; // Меньше запросов для демонстрации
            
            // Используем SemaphoreSlim для ограничения количества одновременных запросов
            using var semaphore = new SemaphoreSlim(10, 10); // Максимум 10 одновременных запросов
            
            var tasks = new List<Task>();
            
            for (int i = 0; i < threadCount; i++)
            {
                int threadId = i;
                for (int j = 0; j < requestsPerThread; j++)
                {
                    int requestId = j;
                    tasks.Add(MakeImprovedRequest(threadId, requestId, semaphore));
                }
            }
            
            try
            {
                await Task.WhenAll(tasks);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Общее исключение в улучшенном подходе: {ex.Message}");
            }
            
            Console.WriteLine($"\nУлучшенный подход завершен. Всего результатов: {_results.Count}");
            Console.WriteLine($"Всего исключений: {_exceptions.Count}");
        }

        private static async Task MakeImprovedRequest(int threadId, int requestId, SemaphoreSlim semaphore)
        {
            await semaphore.WaitAsync();
            
            try
            {
                Interlocked.Increment(ref _activeRequests);
                
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                
                string url = $"https://httpbin.org/delay/1?thread={threadId}&request={requestId}";
                
                using var response = await _configuredHttpClient.GetAsync(url, cts.Token);
                response.EnsureSuccessStatusCode();
                
                var content = await response.Content.ReadAsStringAsync(cts.Token);
                
                _results.Add($"Thread {threadId}, Request {requestId}: Success");
                Console.Write("+");
            }
            catch (OperationCanceledException ex) when (ex.CancellationToken.IsCancellationRequested)
            {
                _exceptions.Add(ex);
                Console.WriteLine($"\nОтмена операции в потоке {threadId}, запрос {requestId}");
            }
            catch (HttpRequestException ex)
            {
                _exceptions.Add(ex);
                Console.WriteLine($"\nHTTP ошибка в потоке {threadId}, запрос {requestId}: {ex.Message}");
            }
            catch (TaskCanceledException ex)
            {
                _exceptions.Add(ex);
                Console.WriteLine($"\nТаймаут в потоке {threadId}, запрос {requestId}");
            }
            catch (Exception ex)
            {
                _exceptions.Add(ex);
                Console.WriteLine($"\nНеожиданная ошибка в потоке {threadId}, запрос {requestId}: {ex.Message}");
            }
            finally
            {
                Interlocked.Decrement(ref _activeRequests);
                semaphore.Release();
            }
        }

        // Обработчик необработанных исключений
        private static void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            Console.WriteLine($"\n!!! НЕОБРАБОТАННОЕ ИСКЛЮЧЕНИЕ: {e.ExceptionObject}");
            Console.WriteLine($"Приложение завершается: {e.IsTerminating}");
        }

        // Обработчик необработанных исключений в Task
        private static void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
        {
            Console.WriteLine($"\n!!! НЕОБРАБОТАННОЕ ИСКЛЮЧЕНИЕ В TASK: {e.Exception}");
            e.SetObserved(); // Предотвращаем падение приложения
        }
    }
}