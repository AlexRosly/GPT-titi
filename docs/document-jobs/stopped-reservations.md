# Звірка резервів після старої помилки передачі документів у фон

Це операторський інструмент, без HTTP endpoint і без автоматичного запуску.
Використовує поточні дані MongoDB, збережений тариф запиту та загальне підтверджене
використання моделі. Не повторює запит до моделі й не запускає Excel job.

## Що сталося у наданій діагностиці

У звіті від 13.11.2026 11:50 за Києвом чотири failed спроби мають
`reservationState=held`, `needsReconciliation=true`. Їхні резерви:

| turnId | attempt | Резерв TITI |
| --- | ---: | ---: |
| b076e33d-32fa-4955-a361-4c3294006afc | 1 | 21 798 |
| e2d90718-d82c-40aa-8828-60966c7ecd47 | 1 | 20 348 |
| 140d0a72-0c11-4b8d-9899-8e728bff35b5 | 1 | 20 058 |
| fd87dccd-f97f-4eae-842f-be29453504c9 | 1 | 14 656 |
| Разом | | **76 860** |

Це точно збігається зі скриншотами сайдбара й Token history. Видимий останній
запит f4aaf01a-49ff-4b3f-a24b-ba8640a379a8 уже settled: одне списання 9 442 TITI,
один release. Його до ремонту не включаємо.

У чотирьох старих спроб збережене підтверджене usage, pending=false. Передача
в локальну job вже відбулася, але job скасована з DOCUMENT_TURN_GONE до першого
chunk. Чинний failTurn зберігає резерв, коли після providerStartedAt
вважає оплату невизначеною. Ці записи залишені на операторську звірку. Конкретний процес,
що записав failed, цією діагностикою не встановлений.

## Коли інструмент допускає звірку

Для кожного явно заданого turnId + attempt одночасно перевіряються:

- failed / PROCESS_INTERRUPTED, held, needsReconciliation=true, без активного
  chat lease, готового providerResult, cancel чи попереднього reconciliation;
- compute kind=document, stage=executing, pending=false, повне узгоджене usage;
  якщо є responseState, його pending=false та usage збігаються;
- точна пов'язана job того самого користувача і спроби: cancelled,
  DOCUMENT_TURN_GONE, finishedAt, нульові cursor/chunks/staging, немає результату,
  lease або залишкових chunk-записів;
- наявний збережений тариф, немає попереднього списання;
- сума підтверджених hold receipts збігається з резервом спроби;
- усі вибрані спроби одного користувача, до 20 спроб за раз.

Це навмисно вузький ремонт саме підтвердженої помилки. Для реального обриву
провайдера з pending=true залишається окрема звірка за даними провайдера через
існуючий reconcileChatReservation.js. Не підставляти noCharge=true без доказів.
Якщо terminal job вже видалена за її семиденним TTL, цей інструмент теж
відмовиться працювати: потрібна окрема перевірка історичних даних.

## Використання

Задати CHAT_RECONCILIATION_MONGO_URI через захищену конфігурацію оператора: URI
саме потрібної бази GPTiti. Скрипт читає .env, але не виводить URI чи env.

Вхід targets.json: `{ "turns": [{ "turnId": "…", "attempt": 1 }] }`.
У комплекті є affected-turns.json з чотирма конкретними спробами вище.

```bash
node scripts/reconcileStoppedDocumentReservations.js --plan affected-turns.json > reservation-plan.json
```

Це тільки читання, без створення індексів і без зміни балансу. У JSON:
entries з usage, прогнозом списання й резервом кожної спроби;
totals.releaseTokens / chargeTokens / availableIncrease;
balanceBefore і projectedBalance. Перевірити 4 потрібні turnId, attempt=1,
releaseTokens=76860. Сума нового списання береться з usage і price snapshot,
а не з величини резерву. 76 860 не означає ні нове списання цієї суми,
ні збільшення загального балансу на цю суму.

Після перевірки отриманого плану:

```bash
node scripts/reconcileStoppedDocumentReservations.js --apply reservation-plan.json > reservation-result.json
```

Повторна перевірка всіх даних та fingerprint виконується всередині однієї
Mongo-транзакції. Зміна usage, тарифу чи стану після --plan відхиляє операцію.
Якщо одна зі спроб не проходить перевірку, весь пакет відкочується.
Для кожної спроби стандартний ledger одноразово списує підтверджене usage,
закриває саме її резерв, записує аудит і durable balance outbox. Інші резерви
не змінюються. Повторне застосування того самого успішного плану — no-op.

Запит залишається failed: інструмент не створює неіснуючий готовий файл.
needsReconciliation=false, reservationState=settled, stale documentJob.active=false.
Повідомлення про помилку уточнює, що usage оплачене, резерв закритий.
Працюючий backend доставляє balance.updated зі спільним balanceVersion; сайдбар
і Token history отримують один стан. GET /users/balance дає той самий баланс.

Очікувано releasedTokens=76860. Якщо інших активних резервів немає,
balanceAfter.reservedAppTokens=0. Загальний appTokens зменшується тільки на
chargedTokens, доступний баланс збільшується на releasedTokens-chargedTokens.

REPAIR_* означає відмову, а не дозвіл вручну обнулити User.reservedAppTokens.
Зберегти план, результат/помилку та свіжу діагностику. Не повторювати платний
запит для звірки резервів і не редагувати план, щоб обійти захист.

## Тести

Тільки окрема disposable Mongo replica set у CHAT_V2_TEST_MONGO_URI:

```bash
node --test --test-concurrency=1 test/chatDeliveryV2/stoppedDocumentReservations.integration.test.js
```

Покриття: dry run, 76 860 резерву, обидва API, одноразовість і паралельні
запуски, інший активний резерв, balance outbox, транзакційний rollback,
застарілий план, зміна job, unknown usage, чужий користувач, невідповідність
ledger, CLI без розголошення текстів і URI. Реальних викликів моделі немає.
