# Patch 21 — ізольований браузер у V2

База: `4bbc312` (застосований patch 20). Backend ZIP patch, без зміни фронта.

## Поведінка

За `WEB_READING_V2_ENABLED=true` і `BROWSER_V2_ENABLED=true` поточні повідомлення з явними HTTP(S) URL використовують браузерний шлях. Обидва прапорці перевіряються повторно worker. Без другого прапорця працює незмінений HTML reader patch 20. Повідомлення без URL зберігають попередній streaming/file/OCR шлях. Немає мовного regex для визначення наміру: дії вибирає модель за запитом користувача будь-якою підтримуваною нею мовою.

Можливості: JS-rendered DOM, перехід за видимим посиланням, `details`, ARIA-вкладки, прокрутка, назад, пошук через GET search form. Довільних CSS-селекторів, JavaScript від моделі, кнопок, POST, завантажень, авторизації, публікацій або платежів немає. У мережі сайти інколи змінюють стан навіть GET-запитами; цей режим не є математичною гарантією відсутності ефектів на сторонньому сайті. Він працює без акаунтів і cookies, з вузьким набором дій.

Навігація дозволена в точних origins наданих користувачем URL (макс. 3). Посилання в DOM пропонуються лише в поточному origin. Для другого наданого сайту модель може виконати `open` початкового URL. Редирект на інший origin, включно з www/non-www, блокується: слід передати канонічну адресу. Ресурси CDN дозволені лише на перевірених публічних адресах. JS-сайти, яким необхідні cookies, POST API, WebSockets, iframe або CAPTCHA, можуть не працювати; обходів захисту немає.

`browserInputEnabled` у ChatModels: default true; legacy missing теж true; explicit false залишає HTML reader. Функція потребує function calling у provider API. Відмова 400/422 дає BROWSER_MODEL_UNSUPPORTED, без автоматичних повторних витрат.

`browserVisionEnabled`: default false. Алекс вмикає тільки для перевіреної моделі з image input. Тоді модель отримує поточний viewport JPEG (не всю довгу сторінку), із резервом на image tokens. Скриншот не записується у Mongo/історію; джерела містять текст та метадані. Це обмеження можливостей моделі, а не прив'язка до її ID.

## Ізоляція та встановлення

Окремий контейнер на завдання, без мережі (`--network=none`), host mounts, ключів OpenAI/БД та Docker socket. Chromium sandbox увімкнений, non-root pwuser, read-only rootfs, тимчасовий /tmp, cap-drop ALL, no-new-privileges, seccomp профіль Playwright. CPU 1, memory 768 MiB, swap не додається, pids 160, /tmp 256 MiB, /dev/shm 128 MiB. Не послаблювати sandbox, щоб обійти невдалий smoke test.

Rootless Docker рекомендований для окремого runtime-користувача. Доступ до rootful Docker daemon є привілейованим: не надавайте його недовіреним користувачам. Для першого розгортання Алекс має налаштувати Docker і переконатися, що системна політика user namespaces дозволяє Chromium sandbox. Docker у середовищі розробки патча відсутній — це не перевірене тут розгортання.

Playwright package/image pinned 1.64.1; seccomp отриманий з офіційного microsoft/playwright tag v1.64.1 (`utils/docker/seccomp_profile.json`, Apache-2.0). Package lock додається для окремого worker. Оновлювати пакет і image разом. Образ потрібно зібрати заздалегідь, runtime `--pull=never`.

Вебзапити runner передає через stdin/stdout до бекенду. Шлюз виконує лише GET, перевіряє всі DNS відповіді і підключається до перевіреної IP без повторного DNS, перевіряє редиректи, не передає cookies/authorization/referer і не повертає Set-Cookie. Browser route не має прямого мережевого fallback. Service workers, WebSockets, downloads, popup, iframe та форми заблоковані. У контейнер немає жодного секрету застосунку.

## Ліміти

- 2 активні браузери на Node process (при кількох PM2 workers ліміт множиться).
- 180 с сесія; 30 с дія; 15 с HTTP ресурс; 45 с provider request timeout у межах загального deadline.
- Початкове відкриття + до 4 дій навігації; до 5 викликів моделі включно з фінальним.
- До 50 контролів, 8 KiB тексту на спостереження; до 5 спостережень.
- 120 GET ресурсів, до 8 одночасно; до 2 MiB compressed/decoded на ресурс; 16 MiB сумарного decoded download.
- До 400 KB JPEG viewport; до 4096 completion tokens на виклик; чинний web context cap.
- HTML кеш власника в ChatTurn, як patch 20, з обмеженим обсягом. Окремого довгострокового browser profile чи загальної cookie сесії немає.

## Резервування і відновлення

Перед КОЖНИМ provider call транзакція збільшує резерв до вже спожитої фактичної вартості + оцінки наступного payload. Враховуються історія, вкладення, інструменти, вебтекст, зображення і output cap. Новий резерв має унікальний ключ turn/attempt/call. Provider boundary і резерв записуються атомарно. Тест конкурентного запуску включений.

Usage отримується з provider і накопичується; одна фінальна транзакція списує сумарну вартість та звільняє залишок. Відсутність usage не підмінюється вигаданою точною сумою — reconciliation. Локальний Docker не має зовнішнього платного browser API: окремий тариф інфраструктури в patch 21 не стягується. Якщо такий тариф потрібен, його треба окремо погодити й додати до ledger; модельні tokens ним не підміняються.

Помилка до платного виклику: failed/released. Відома помилка після попередніх завершених викликів: збережена відповідь про неповний результат + одне списання вже відомого usage. Невідомий результат provider request: failed/held, needsReconciliation, без auto-retry.

Після падіння worker завершені браузерні дії не повторюються. Збережений фінальний результат завершується локально. Якщо фінального результату немає, але всі provider calls мають usage, повертається явний неповний результат і списання відомого usage. Якщо виклик pending — звірка. Прозоре продовження браузерної сесії після crash не реалізоване: ephemeral контейнер не відновлюється.

Фінальна відповідь і джерела зберігаються через чинний V2. У браузерному режимі проміжний текст моделі не стрімиться; snapshot.webStatus повідомляє opening_browser/navigating/reading/answering. Новий фронт з прогресом та локалізованими BROWSER_* помилками — наступний PR. Наявний виправлений фронт приймає невідомі error codes з безпечним fallback. Кнопка Stop у цей backend patch не входить; сесія обмежена deadline.

## Валідація

`npm run test:browser`: policy, GET broker, references, actions, actual usage accumulation, known/ambiguous errors, insufficient reserve, vision privacy.
`npm run test:browser:smoke`: реальний Docker/Chromium на локально підставлених HTML fixtures, без публічної мережі/OpenAI. Перевіряє JS, details, follow/back, search, viewport і блокування loopback.
`npm run test:browser:integration`: Mongo replica-set, mocked browser/provider: V2 admission, multiple calls/one debit, hold/release, recovery without replay, concurrent boundaries, opt-out fallback. Тести знищують лише окрему БД `gptiti_files_test_*`.

Smoke test та Mongo integration треба виконати на сервері до ввімкнення. Unit тести не доводять працездатність Docker sandbox на конкретному хості або сумісність усіх моделей.
