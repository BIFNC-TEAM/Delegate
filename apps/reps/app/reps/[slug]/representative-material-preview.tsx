"use client";

import { useId, useState } from "react";

export type RepresentativeMaterialPreviewCopy = {
  close: string;
  download: string;
  noDownload: string;
  open: string;
  summaryLabel: string;
};

export function RepresentativeMaterialPreview({
  copy,
  downloadUrl,
  kind,
  summary,
  title,
}: {
  copy: RepresentativeMaterialPreviewCopy;
  downloadUrl?: string | null;
  kind: string;
  summary: string;
  title: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const headingId = useId();

  return (
    <>
      <button className="button-secondary" onClick={() => setIsOpen(true)} type="button">
        {copy.open}
      </button>
      {isOpen ? (
        <div
          aria-labelledby={headingId}
          aria-modal="true"
          className="representative-material-modal"
          role="dialog"
        >
          <button
            aria-label={copy.close}
            className="representative-material-modal-backdrop"
            onClick={() => setIsOpen(false)}
            type="button"
          />
          <section className="representative-material-modal-card">
            <div className="dashboard-surface-header">
              <div>
                <p className="eyebrow">{kind}</p>
                <h3 id={headingId}>{title}</h3>
              </div>
              <button className="button-secondary" onClick={() => setIsOpen(false)} type="button">
                {copy.close}
              </button>
            </div>
            <div className="representative-material-preview-body">
              <p className="panel-title">{copy.summaryLabel}</p>
              <p>{summary}</p>
            </div>
            <div className="button-row">
              {downloadUrl ? (
                <a className="button-primary" href={downloadUrl} rel="noreferrer" target="_blank">
                  {copy.download}
                </a>
              ) : (
                <span className="chip">{copy.noDownload}</span>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
