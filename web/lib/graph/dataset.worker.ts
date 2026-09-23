import { readDataset } from './dataset';
import { DATA_FILES, type DatasetBytes, type WorkerReply } from './types';

const send = (message: WorkerReply) => self.postMessage(message);
self.onmessage = async (event: MessageEvent<{ files?: File[] }>) => {
  try {
    const files = event.data.files;
    send({
      type: 'progress',
      message: files
        ? 'Открываем выбранные файлы…'
        : 'Загружаем демонстрационный набор…',
    });
    const entries = await Promise.all(
      DATA_FILES.map(async (name) => {
        if (files) {
          const matches = files.filter((f) => f.name === name);
          if (matches.length !== 1)
            throw new Error(
              matches.length
                ? `Несколько файлов ${name}; оставьте один`
                : `Не хватает ${name}`,
            );
          return [name, await matches[0].arrayBuffer()] as const;
        }
        const response = await fetch(`/data/${name}`, { cache: 'no-cache' });
        if (!response.ok)
          throw new Error(`Не удалось загрузить ${name} (${response.status})`);
        return [name, await response.arrayBuffer()] as const;
      }),
    );
    const dataset = await readDataset(
      Object.fromEntries(entries) as DatasetBytes,
      (message) => send({ type: 'progress', message }),
    );
    send({ type: 'success', dataset });
  } catch (error) {
    send({
      type: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'Не удалось открыть набор данных',
    });
  }
};
