# Patch 22 — контракт браузерних дій і діагностика

База: 6c2d4d7 (patch 21). Seccomp-правка chroot, застосована Алексом окремо, цим патчем не змінюється. Docker image rebuild не потрібен.

## Виявлена неузгодженість

Інструмент browse раніше описував kind/ref/query/url разом, але валідатор дозволяв лише поля конкретної дії. Тому follow з коректним ref та порожніми query/url відхилявся. Це відтворюваний дефект контракту; оригінальні аргументи зі збійного запиту не збережені, тому не стверджуємо, що причина саме того запиту вже доведена.

## Зміни

- Одне визначення контракту в src/services/browser/actions.js.
- strict:true, additionalProperties:false, всі чотири поля required; невикористані ref/query/url мають бути null. Опис кожного поля пояснює його застосування. Джерело формату: https://developers.openai.com/api/docs/guides/function-calling#strict-mode.
- Валідатор підтримує також попередні мінімальні аргументи та порожні рядки в невикористаних відомих полях. У runner передається лише канонічна дія з потрібними полями.
- Заповнені зайві поля, невідомі ключі, довільні назви дій, приватні URL і неіснуючі/чужі типу дії refs відхиляються.
- finish_reason=stop допускається тільки за наявності рівно одного повністю валідного function call browse. Текстова відповідь без tool call не перетворюється на дію. length/content_filter/refusal/multiple calls завжди відхиляються.
- Немає повторного виклику моделі для виправлення помилки. Ліміти та підрахунок usage не змінено.

## Діагностика

У server log:
- BROWSER_ACTION_REJECTED — конкретна причина відхилення;
- BROWSER_ACTION_NORMALIZED — обробка порожніх полів або сумісного finish_reason=stop.

Останній такий запис зберігається в ChatTurn.browserState.lastActionDiagnostic, приватно у поточному turn. Це не публічний DTO і не новий endpoint.

Поля: turnId, attempt, modelId, call, reason, finishReason (обмежений перелік), toolCount, argumentBytes; за потреби kind/field/normalizedFields з фіксованих переліків. Raw arguments, query, URL, назви/текст сторінок, labels, screenshots, повідомлення provider та довільні невідомі ключі не записуються.

| reason | Значення |
|---|---|
| CHOICE_COUNT | Не одна відповідь provider |
| UNSAFE_FINISH_REASON | Обрив, фільтрація або непідтримуваний тип завершення |
| PROVIDER_REFUSAL | Provider відмовив у виконанні |
| TOOL_CALL_COUNT | Немає одного однозначного виклику |
| UNEXPECTED_TOOL | Не browse/function |
| ARGUMENTS_NOT_STRING | Аргументи не JSON-рядок |
| ARGUMENTS_TOO_LARGE | Аргументи понад 32 KiB |
| ARGUMENTS_INVALID_JSON | Пошкоджений JSON |
| ARGUMENTS_NOT_OBJECT | JSON не є об'єктом |
| UNKNOWN_ACTION | Недозволений kind |
| UNKNOWN_ARGUMENT_FIELD | Невідомий ключ |
| UNUSED_ARGUMENT_NOT_EMPTY | Заповнене поле не належить цій дії |
| MISSING_OR_INVALID_ARGUMENT | Потрібне поле відсутнє, порожнє або не рядок |
| CONTROL_NOT_OBSERVED_OR_WRONG_KIND | Ref відсутній у поточному спостереженні або має інший тип |
| URL_REJECTED | Некоректна або заборонена адреса |
| URL_NOT_A_SEED | open виходить за початкові URL користувача |
| SEARCH_QUERY_INVALID | Запит пошуку порушує ліміт/містить control characters |
| ACCEPTED | Прийнята нормалізована дія |

Відомий usage збійного запиту зберігає чинну обробку patch 21. Цей патч не повертає автоматично попередні 902 TITI й не змінює історію оплат.
