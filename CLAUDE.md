# Taldau — Document Translator

## Runtime

Bun only. No Node.js, no npm, no yarn.

- `bun run dev` — запуск с hot-reload, автоочистка порта 3333
- `bun run start` — продакшн-запуск
- `bun run build` — TypeScript проверка, лог в `src/tests/.results/build.log`
- `bun install` — установка зависимостей
- `bun test` — тесты

## Architecture

- `index.ts` — Bun HTTP-сервер (`Bun.serve()`), маршруты, параллельная обработка файлов (`parallelMap` по CPU cores)
- `src/parsers.ts` — XML-парсеры для PPTX (`<a:p>/<a:t>`), DOCX (`<w:p>/<w:t>`), XLSX (`<si>/<t>`), charts (`<c:v>/<c:t>`)
- `src/pdf.ts` — PDF pipeline: извлечение текста (unpdf), нормализация, определение колонок, сборка HTML, генерация PDF (@easykit/pdf)
- `src/translate.ts` — Multi-engine перевод с fallback chain (10 движков: Google gtx, MyMemory, Lingva, Gemini, Groq, DeepL, Google Cloud, Microsoft, OpenAI, Claude), батчинг, 133 языка. Ключи из env vars или SQLite settings.
- `src/db.ts` — SQLite: кэш переводов, глоссарий, settings (API-ключи) (`bun:sqlite`)
- `src/glossary.ts` — защита терминов глоссария Unicode-плейсхолдерами `⟦GL000⟧`
- `src/logger.ts` — structured logging: файл + in-memory ring buffer для UI
- `public/index.html` — HTMX + Alpine.js, без сборки фронтенда
- `scripts/build.sh` — скрипт сборки с цветным выводом и логированием

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

### PDF pipeline
PDF использует отдельный pipeline (не ZIP/XML):
1. `unpdf` извлекает text items с позициями и шрифтами
2. `normalizeItems()` — склейка разбитых glyphs по X-proximity, нормализация пробелов, Unicode NFC
3. `sortItems()` — сортировка по порядку чтения (Y desc → X asc)
4. `detectColumns()` — кластеризация по X-позиции для определения колонок
5. `buildInternalDoc()` — группировка в параграфы и таблицы (InternalDoc model)
6. Перевод через существующий `translateBatch()`
7. `buildTranslatedHtml()` — positioned HTML с adaptive font-size
8. `renderToPdf()` — генерация PDF через @easykit/pdf (Chromium CDP), fallback на HTML

Ограничения PDF: макс 50MB, макс 100 страниц. Изображения не извлекаются.

## APIs

- `Bun.serve()` — HTTP-сервер. Не использовать express.
- `bun:sqlite` — кэш переводов. Не использовать better-sqlite3.
- `Bun.file` — чтение файлов. Предпочтительнее `node:fs`.
- JSZip — распаковка/запаковка Office документов (ZIP/OOXML).
- unpdf — извлечение текста из PDF.
- @easykit/pdf — генерация PDF из HTML через Chromium CDP.
