# GPT-titi

The service for work with AI instrument

## Необхідні змінні .env для WebSocket
Для налаштування WebSocket-сервера потрібно вказати у `.env` тільки такі змінні:

```
SOCKET_CORS_ORIGINS=http://localhost:3000,https://www.gptiti.com
SOCKET_CREDENTIALS=true
```

**Пояснення:**
- `SOCKET_CORS_ORIGINS` — список дозволених origin для WebSocket (через кому)
- `SOCKET_CREDENTIALS` — чи дозволяти credentials (true/false)



WEBSOCKET 

# Інструкція для backend: як додавати нові підписки та емiти через WebSocket



## Загальна архітектура
Сервер використовує універсальний протокол повідомлень через канал `ws:message` (див. src/wsServer.js). Всі події між фронтом і сервером проходять через цей канал з об'єктом формату:

```
{
	event: string,        // назва події
	type: string,         // тип повідомлення (request/response/error тощо)
	requestId: string,    // id запиту для співставлення відповідей
	payload: object       // корисне навантаження
}
```

## Як додати нову підписку сервера на повідомлення від фронта
1. Відкрийте файл `src/wsServer.js`.
2. Усередині обробника `io.on('connection', (socket) => { ... })` додайте нову гілку в обробнику події `socket.on('ws:message', ...)`.
3. Перевірте поле `event` у вхідному повідомленні та реалізуйте потрібну логіку.

**Приклад:**
```js
// ...existing code...
socket.on('ws:message', async (msg) => {
	const { event, type, requestId, payload } = msg;
	if (event === 'myCustomEvent') {
		// Ваша логіка обробки
		// Наприклад, надіслати відповідь:
		socket.emit('ws:message', {
			event: 'myCustomEvent',
			type: 'response',
			requestId,
			payload: { result: 'ok' }
		});
	}
	// ...existing code...
});
// ...existing code...
```

## Як відправити нову подію з сервера на фронти
1. Імпортуйте функцію `getIo` з `src/wsServer.js` у потрібному місці backend.
2. Отримайте екземпляр io: `const io = getIo();`
3. Використовуйте `io.emit('ws:message', { ... })` для відправки події всім фронтам, або `socket.emit(...)` для конкретного користувача.

**Приклад:**
```js
const { getIo } = require('./wsServer');
const io = getIo();
io.emit('ws:message', {
	event: 'notifyAll',
	type: 'info',
	requestId: null,
	payload: { message: 'Важливе повідомлення' }
});
```

## Best practices
- Завжди використовуйте універсальний формат повідомлення.
- Для відповідей на запити використовуйте той самий `requestId`, що і в запиті.
- Для broadcast-повідомлень використовуйте `io.emit`, для персональних — `socket.emit`.
- Не додавайте нові socket.io події, використовуйте лише `ws:message`.
- Документуйте нові типи подій і payload у цьому README або окремому файлі.

---
Інструкція тільки для backend. Для фронта буде інструкція всередині рідмі в репозиторії фронту.

