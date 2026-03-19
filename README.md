# Taldau

Переводчик документов (.pptx, .docx, .xlsx, .pdf) с веб-интерфейсом. Поддерживает 133 языка, параллельную обработку файлов и кэширование переводов.

## Возможности

- Перевод документов PowerPoint, Word, Excel и PDF с сохранением форматирования
- 133 языка (все языки Google Translate)
- 10 движков перевода с автоматическим fallback:
  - Бесплатные: Google Translate, MyMemory, Lingva
  - Free tier: Gemini, Groq
  - Подписка: DeepL, Google Cloud, Microsoft, OpenAI, Claude
- Параллельная обработка файлов
- Кэширование переводов в SQLite
- Глоссарий — пользовательские термины, которые переводятся строго по словарю
- Управление API-ключами через веб-интерфейс (сохранение в SQLite)
- Drag & drop загрузка
- Прогресс-бар в реальном времени
- Логирование с фильтрацией по уровню
- Список переведённых файлов с возможностью скачивания

## Стек

- [Bun](https://bun.sh) — рантайм, HTTP-сервер
- [HTMX](https://htmx.org) + [Alpine.js](https://alpinejs.dev) — интерфейс
- SQLite — кэш переводов и глоссарий
- [JSZip](https://stuk.github.io/jszip/) — работа с Office документами
- [unpdf](https://github.com/nicolo-ribaudo/unpdf) — извлечение текста из PDF
- [@easykit/pdf](https://github.com/solar-path/easykit-pdf) — генерация PDF через Chromium

## Установка

```bash
bun install
```

## Запуск

```bash
bun run start
```

Сервер запустится на `http://localhost:3333`.

Для разработки с автоперезагрузкой:

```bash
bun run dev
```

Проверка TypeScript:

```bash
bun run build
```

Результат сохраняется в `src/tests/.results/build.log`.

## Переменные окружения

API-ключи можно задать через переменные окружения **или** через веб-интерфейс (карточка API Keys). Приоритет: env var > SQLite.

| Переменная | По умолчанию | Описание |
|------------|-------------|----------|
| `PORT` | `3333` | Порт HTTP-сервера |
| | | **Free tier (API key бесплатный)** |
| `GEMINI_API_KEY` | — | Google Gemini (15 RPM, 1500 req/day) |
| `GROQ_API_KEY` | — | Groq (30 RPM, 14400 req/day) |
| | | **Подписка (API key от компании)** |
| `DEEPL_API_KEY` | — | DeepL ($5.49/1M символов, free: 500K/мес) |
| `GOOGLE_CLOUD_API_KEY` | — | Google Cloud Translation ($20/1M символов) |
| `MICROSOFT_TRANSLATOR_KEY` | — | Microsoft Translator ($10/1M символов, 2M free/мес) |
| `MICROSOFT_TRANSLATOR_REGION` | `global` | Регион Azure (если отличается) |
| `OPENAI_API_KEY` | — | OpenAI GPT-4o-mini (~$0.15/1M токенов) |
| `ANTHROPIC_API_KEY` | — | Claude Haiku (~$0.25/1M токенов) |

## Структура проекта

```
index.ts              — HTTP-сервер, маршруты, обработка документов
public/index.html     — веб-интерфейс (HTMX + Alpine.js)
scripts/build.sh      — скрипт сборки
src/
  parsers.ts          — парсеры Office XML (PPTX, DOCX, XLSX)
  pdf.ts              — PDF pipeline (извлечение, нормализация, генерация)
  translate.ts         — multi-engine перевод (10 движков, 133 языка)
  glossary.ts          — защита терминов глоссария
  db.ts               — SQLite: кэш, глоссарий, settings (API-ключи)
  logger.ts           — логирование
original/             — загруженные оригиналы
result/               — переведённые документы
logs/                 — логи
```

## Поддерживаемые форматы

| Формат | Метод | Особенности |
|--------|-------|-------------|
| .pptx | ZIP/XML | Слайды, графики, мастер-слайды |
| .docx | ZIP/XML | Документ, хедеры, футеры |
| .xlsx | ZIP/XML | Shared strings |
| .pdf | unpdf + Chromium | Извлечение текста с позициями, нормализация glyphs, определение колонок, adaptive layout |
