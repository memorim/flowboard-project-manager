# Окружение

Node 24.18.0, pnpm 11.7.0; `.node-version`, `packageManager`, lockfile и CI используют согласованные версии. `pnpm start` работает без `.env`. Пример смены порта: отредактировать `.env.example` и выполнить `node --env-file=.env.example --import tsx server/index.ts`. Файл читается только при явном `--env-file`. Не помещайте секреты в отслеживаемые файлы.
