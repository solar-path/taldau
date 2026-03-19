# Taldau — Office Document Translator

## Runtime

Bun only. No Node.js, no npm, no yarn.

- `bun run dev` — запуск с hot-reload (`--watch`)
- `bun run start` — продакшн-запуск
- `bun install` — установка зависимостей
- `bun test` — тесты

## Architecture

- `index.ts` — Bun HTTP-сервер (`Bun.serve()`), маршруты, параллельная обработка файлов (`parallelMap` по CPU cores)
- `src/parsers.ts` — XML-парсеры для PPTX (`<a:p>/<a:t>`), DOCX (`<w:p>/<w:t>`), XLSX (`<si>/<t>`), charts (`<c:v>/<c:t>`)
- `src/translate.ts` — Google Translate API (free gtx endpoint), батчинг, retry с таймаутом 8s
- `src/db.ts` — SQLite-кэш переводов (`bun:sqlite`)
- `src/logger.ts` — structured logging: файл + in-memory ring buffer для UI
- `public/index.html` — HTMX + Alpine.js, без сборки фронтенда

## Key decisions

### Paragraph-level translation
Office XML разбивает текст на множество `<a:t>` run'ов внутри одного параграфа. Мы склеиваем текст всех run'ов, переводим целиком, результат вставляем в первый run, остальные очищаем. Это сохраняет форматирование первого run'а.

### Index-based replacement
Замена текста в XML делается по абсолютным позициям символов (не через `string.replace()`), чтобы корректно обрабатывать дубликаты параграфов.

### Text filtering
`shouldSkipText()` в parsers.ts фильтрует: числа, XML-фрагменты, плейсхолдеры `[VALUE]`, маркеры `‹#›`, одиночные символы. Это сократило API-вызовы на ~30%.

### XML safety
- Экранирование `&`, `<`, `>`, `"` (но НЕ `'` → `&apos;` — Windows PowerPoint ломается)
- Валидация после модификации: проверка неэкранированных `&`, баланс тегов
- При ошибке парсинга возвращается оригинальный XML (не ломаем файл)

### Skipped file types
notesSlides, slideMasters, slideLayouts — содержат только номера страниц и шаблоны, не реальный контент.

## APIs

- `Bun.serve()` — HTTP-сервер. Не использовать express.
- `bun:sqlite` — кэш переводов. Не использовать better-sqlite3.
- `Bun.file` — чтение файлов. Предпочтительнее `node:fs`.
- JSZip — распаковка/запаковка Office документов (ZIP/OOXML).
