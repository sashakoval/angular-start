using System;
using System.Collections.Concurrent;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace HttpClientBestPractices
{
    /// <summary>
    /// Пример лучших практик для использования HttpClient в многопоточном окружении
    /// </summary>
    public class HttpClientService
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<HttpClientService> _logger;
        private readonly SemaphoreSlim _semaphore;
        private readonly CancellationTokenSource _cancellationTokenSource;

        public HttpClientService(IHttpClientFactory httpClientFactory, ILogger<HttpClientService> logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _semaphore = new SemaphoreSlim(10, 10); // Максимум 10 одновременных запросов
            _cancellationTokenSource = new CancellationTokenSource();
        }

        /// <summary>
        /// Безопасный метод для выполнения HTTP запросов в многопоточном окружении
        /// </summary>
        public async Task<string> MakeRequestAsync(string url, int threadId, int requestId)
        {
            // Ждем освобождения слота в семафоре
            await _semaphore.WaitAsync(_cancellationTokenSource.Token);

            try
            {
                _logger.LogInformation("Начало запроса: Thread {ThreadId}, Request {RequestId}, URL: {Url}", 
                    threadId, requestId, url);

                using var httpClient = _httpClientFactory.CreateClient("SafeClient");
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(_cancellationTokenSource.Token);
                cts.CancelAfter(TimeSpan.FromSeconds(30)); // Таймаут на запрос

                using var response = await httpClient.GetAsync(url, cts.Token);
                response.EnsureSuccessStatusCode();

                var content = await response.Content.ReadAsStringAsync(cts.Token);
                
                _logger.LogInformation("Успешный запрос: Thread {ThreadId}, Request {RequestId}, Status: {StatusCode}", 
                    threadId, requestId, response.StatusCode);

                return content;
            }
            catch (OperationCanceledException ex) when (ex.CancellationToken == _cancellationTokenSource.Token)
            {
                _logger.LogWarning("Запрос отменен (общая отмена): Thread {ThreadId}, Request {RequestId}", 
                    threadId, requestId);
                throw;
            }
            catch (OperationCanceledException ex)
            {
                _logger.LogWarning("Таймаут запроса: Thread {ThreadId}, Request {RequestId}", 
                    threadId, requestId);
                throw new TimeoutException($"Request timeout for thread {threadId}, request {requestId}", ex);
            }
            catch (HttpRequestException ex)
            {
                _logger.LogError(ex, "HTTP ошибка: Thread {ThreadId}, Request {RequestId}", 
                    threadId, requestId);
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Неожиданная ошибка: Thread {ThreadId}, Request {RequestId}", 
                    threadId, requestId);
                throw;
            }
            finally
            {
                _semaphore.Release();
            }
        }

        /// <summary>
        /// Метод с retry логикой
        /// </summary>
        public async Task<string> MakeRequestWithRetryAsync(string url, int threadId, int requestId, int maxRetries = 3)
        {
            Exception lastException = null;

            for (int attempt = 1; attempt <= maxRetries; attempt++)
            {
                try
                {
                    return await MakeRequestAsync(url, threadId, requestId);
                }
                catch (TimeoutException ex) when (attempt < maxRetries)
                {
                    lastException = ex;
                    var delay = TimeSpan.FromSeconds(Math.Pow(2, attempt - 1)); // Exponential backoff
                    _logger.LogWarning("Попытка {Attempt} неудачна, повтор через {Delay}s: Thread {ThreadId}, Request {RequestId}", 
                        attempt, delay.TotalSeconds, threadId, requestId);
                    
                    await Task.Delay(delay, _cancellationTokenSource.Token);
                }
                catch (HttpRequestException ex) when (attempt < maxRetries && IsRetriableError(ex))
                {
                    lastException = ex;
                    var delay = TimeSpan.FromSeconds(Math.Pow(2, attempt - 1));
                    _logger.LogWarning("HTTP ошибка, попытка {Attempt}, повтор через {Delay}s: Thread {ThreadId}, Request {RequestId}", 
                        attempt, delay.TotalSeconds, threadId, requestId);
                    
                    await Task.Delay(delay, _cancellationTokenSource.Token);
                }
            }

            _logger.LogError("Все попытки исчерпаны для Thread {ThreadId}, Request {RequestId}", threadId, requestId);
            throw lastException ?? new InvalidOperationException("All retry attempts failed");
        }

        private static bool IsRetriableError(HttpRequestException ex)
        {
            // Определяем, стоит ли повторять запрос при данной ошибке
            var message = ex.Message.ToLower();
            return message.Contains("timeout") || 
                   message.Contains("connection") || 
                   message.Contains("network") ||
                   message.Contains("502") ||
                   message.Contains("503") ||
                   message.Contains("504");
        }

        /// <summary>
        /// Graceful shutdown
        /// </summary>
        public async Task ShutdownAsync()
        {
            _logger.LogInformation("Начало graceful shutdown...");
            
            _cancellationTokenSource.Cancel();
            
            // Ждем завершения всех активных запросов (максимум 30 секунд)
            var shutdownTimeout = TimeSpan.FromSeconds(30);
            var shutdownCts = new CancellationTokenSource(shutdownTimeout);
            
            try
            {
                // Ждем пока все слоты семафора не освободятся
                for (int i = 0; i < 10; i++)
                {
                    await _semaphore.WaitAsync(shutdownCts.Token);
                    _semaphore.Release();
                }
                
                _logger.LogInformation("Graceful shutdown завершен успешно");
            }
            catch (OperationCanceledException)
            {
                _logger.LogWarning("Graceful shutdown прерван по таймауту");
            }
            finally
            {
                _semaphore.Dispose();
                _cancellationTokenSource.Dispose();
            }
        }
    }

    /// <summary>
    /// Пример консольного приложения с правильной настройкой
    /// </summary>
    public class Program
    {
        public static async Task Main(string[] args)
        {
            // Настройка DI контейнера
            var services = new ServiceCollection();
            
            // Настройка логирования
            services.AddLogging(builder =>
            {
                builder.AddConsole();
                builder.SetMinimumLevel(LogLevel.Information);
            });

            // Настройка HttpClient
            services.AddHttpClient("SafeClient", client =>
            {
                client.Timeout = TimeSpan.FromSeconds(30);
                client.DefaultRequestHeaders.Add("User-Agent", "SafeMultiThreadApp/1.0");
            })
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler()
            {
                MaxConnectionsPerServer = 50, // Увеличиваем лимит подключений
                UseProxy = false // Отключаем прокси для лучшей производительности
            });

            services.AddSingleton<HttpClientService>();

            var serviceProvider = services.BuildServiceProvider();
            var httpClientService = serviceProvider.GetRequiredService<HttpClientService>();
            var logger = serviceProvider.GetRequiredService<ILogger<Program>>();

            // Настройка обработчиков необработанных исключений
            AppDomain.CurrentDomain.UnhandledException += (sender, e) =>
            {
                logger.LogCritical("Необработанное исключение: {Exception}", e.ExceptionObject);
            };

            TaskScheduler.UnobservedTaskException += (sender, e) =>
            {
                logger.LogError("Необработанное исключение в Task: {Exception}", e.Exception);
                e.SetObserved(); // Предотвращаем падение приложения
            };

            try
            {
                logger.LogInformation("Запуск многопоточного HTTP клиента...");

                // Запускаем 50 потоков с запросами
                await RunMultiThreadedRequests(httpClientService, logger);

                logger.LogInformation("Все запросы завершены успешно");
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Критическая ошибка в приложении");
            }
            finally
            {
                await httpClientService.ShutdownAsync();
                await serviceProvider.DisposeAsync();
            }
        }

        private static async Task RunMultiThreadedRequests(HttpClientService httpClientService, ILogger logger)
        {
            const int threadCount = 50;
            const int requestsPerThread = 5;
            
            var allTasks = new List<Task>();
            var results = new ConcurrentBag<string>();
            var errors = new ConcurrentBag<Exception>();

            for (int threadId = 0; threadId < threadCount; threadId++)
            {
                int currentThreadId = threadId;
                
                for (int requestId = 0; requestId < requestsPerThread; requestId++)
                {
                    int currentRequestId = requestId;
                    
                    var task = Task.Run(async () =>
                    {
                        try
                        {
                            string url = $"https://httpbin.org/delay/1?thread={currentThreadId}&request={currentRequestId}";
                            
                            var result = await httpClientService.MakeRequestWithRetryAsync(
                                url, currentThreadId, currentRequestId);
                            
                            results.Add($"Thread {currentThreadId}, Request {currentRequestId}: Success");
                        }
                        catch (Exception ex)
                        {
                            errors.Add(ex);
                            logger.LogError(ex, "Ошибка в Thread {ThreadId}, Request {RequestId}", 
                                currentThreadId, currentRequestId);
                        }
                    });
                    
                    allTasks.Add(task);
                }
            }

            // Ждем завершения всех задач
            await Task.WhenAll(allTasks);

            logger.LogInformation("Результаты: Успешных запросов: {SuccessCount}, Ошибок: {ErrorCount}", 
                results.Count, errors.Count);
        }
    }
}