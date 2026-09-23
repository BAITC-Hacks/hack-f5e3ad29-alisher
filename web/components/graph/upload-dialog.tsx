'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, FileUp, LoaderCircle, X } from 'lucide-react';
import { DATA_FILES } from '@/lib/graph/types';

export function UploadDialog({
  loading,
  error,
  onLoad,
  onClose,
}: {
  loading: string | null;
  error: string | null;
  onLoad: (files: File[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const missing = DATA_FILES.filter(
    (name) => !files.some((f) => f.name === name),
  );
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  function addFiles(incoming: File[]) {
    const merged = new Map(files.map((f) => [f.name, f]));
    for (const f of incoming) merged.set(f.name, f);
    setFiles([...merged.values()]);
  }
  return (
    <dialog
      ref={dialog}
      className="upload-dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="upload-title"
    >
      <div className="upload-heading">
        <div>
          <span className="eyebrow">Свой набор данных</span>
          <h2 id="upload-title">Открыть данные</h2>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Закрыть загрузку"
        >
          <X size={20} />
        </button>
      </div>
      <p className="muted">
        Выберите исходные Parquet и CSV из анализа. Файлы обрабатываются в вашем
        браузере.
      </p>
      <div
        className={`upload-drop ${dragging ? 'is-dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!loading) addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <FileUp size={30} />
        <strong>Перетащите файлы сюда</strong>
        <span>Можно добавлять их по частям</span>
        <button
          className="primary-button"
          disabled={!!loading}
          onClick={() => input.current?.click()}
        >
          Выбрать файлы
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept=".parquet,.csv"
          className="sr-only"
          aria-label="Файлы Parquet и CSV"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
      <div className="upload-file-list">
        {DATA_FILES.map((name) => (
          <div
            key={name}
            className={files.some((f) => f.name === name) ? 'file-present' : ''}
          >
            <span>{name}</span>
            {files.some((f) => f.name === name) ? (
              <Check size={15} aria-label="Выбран" />
            ) : (
              <span className="muted">Ожидается</span>
            )}
          </div>
        ))}
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="upload-footer">
        <span aria-live="polite">
          {loading ??
            (missing.length
              ? `Осталось файлов: ${missing.length}`
              : 'Все файлы выбраны')}
        </span>
        <button
          className="primary-button"
          disabled={!!missing.length || !!loading}
          onClick={() => onLoad(files)}
        >
          {loading ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <FileUp size={16} />
          )}{' '}
          Открыть граф
        </button>
      </div>
    </dialog>
  );
}
