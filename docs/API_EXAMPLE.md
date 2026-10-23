# Пример API

Ответ получен при локальном запуске проверяемой версии. Данные демонстрационные.

```http
GET /api/meta HTTP/1.1
Host: localhost:4100
```

HTTP 200

```json
{
  "projects": [
    {
      "id": 2,
      "name": "Care Dashboard",
      "client": "Medline",
      "color": "#7c64e3",
      "progress": 42,
      "due_date": "2026-08-02"
    },
    {
      "id": 3,
      "name": "Merchant Portal",
      "client": "Vektor",
      "color": "#32a875",
      "progress": 84,
      "due_date": "2026-07-11"
    },
    {
      "id": 1,
      "name": "Nova Mobile",
      "client": "Nova Bank",
      "color": "#ff6b3d",
      "progress": 68,
      "due_date": "2026-07-18"
    }
  ],
  "members": [
    {
      "id": 1,
      "name": "Анна Морозова",
      "role": "Product designer",
      "initials": "АМ",
      "color": "#ff8f66"
    },
    {
      "id": 2,
      "name": "Илья Власов",
      "role": "Frontend developer",
      "initials": "ИВ",
      "color": "#b9a7ff"
    },
    {
      "id": 3,
      "name": "Марк Левин",
      "role": "Backend developer",
      "initials": "МЛ",
      "color": "#8ed8b5"
    },
    {
      "id": 4,
      "name": "Саша Ким",
      "role": "Product manager",
      "initials": "СК",
      "color": "#f4ca64"
    }
  ]
}
```
