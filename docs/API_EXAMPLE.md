# Пример Node API

API ниже предназначен для доверенного локального запуска. X-Demo-Actor — выбор демонстрационного участника, не аутентификация. Размещённая версия игнорирует этот заголовок и требует входа через ChatGPT.

```http
POST /api/tasks
Content-Type: application/json
X-Demo-Actor: 4

{"title":"Подготовить макет","description":"Проверить мобильную версию","status":"todo","priority":"medium","projectId":1,"assigneeId":null,"dueDate":"2030-01-10"}
```

```json
{"id":9,"title":"Подготовить макет","description":"Проверить мобильную версию","status":"todo","priority":"medium","projectId":1,"assigneeId":null,"dueDate":"2030-01-10"}
```

Ответ 201; id зависит от базы. Для редактирования передайте полный объект по PATCH /api/tasks/9. Для смены статуса: PATCH /api/tasks/9/status с {"status":"done"}. GET /api/dashboard покажет новый процент и фактическое событие.
