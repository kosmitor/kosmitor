import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from './session.tsx';
import { downloadFile } from './api.ts';
import { stashImportFile, IMPORT_ACCEPT } from './importHandoff.ts';
import { Icon } from './icons.tsx';
import { cx, useToast } from './ui.tsx';

/**
 * A drop zone that hands a CSV, XML, Excel or PDF file to the import wizard with the
 * import kind preselected. Used on the cap table page (header dialog and empty
 * state) so importing does not start from a separate screen. A spreadsheet goes
 * through the mapping steps; a PDF is kept as a document instead.
 */
export function ImportDropZone({ kind, title, compact = false }: { kind: string; title?: string; compact?: boolean }) {
  const { companyId } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [dragging, setDragging] = useState(false);

  const receive = (file: File | undefined) => {
    if (!file) return;
    stashImportFile(file, kind);
    navigate(`/import?kind=${kind}`);
  };
  const template = (format: 'csv' | 'xml') =>
    downloadFile(`/c/${companyId}/imports/template/${kind}${format === 'xml' ? '?format=xml' : ''}`, `${kind}-template.${format}`)
      .catch((e: Error) => toast(e.message, 'error'));

  return (
    <div>
      <label
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); receive(e.dataTransfer.files[0]); }}
        className={cx('flex cursor-pointer flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed text-center transition-colors',
          compact ? 'px-5 py-7' : 'px-6 py-10',
          dragging ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-white hover:border-ink-300 hover:bg-ink-50/50')}>
        <input type="file" className="hidden" accept={IMPORT_ACCEPT}
          onChange={(e) => { receive(e.target.files?.[0]); e.target.value = ''; }} />
        <span className="grid size-11 place-items-center rounded-full bg-brand-50 text-brand-600"><Icon name="inbox" className="size-5" /></span>
        <span className="text-[14px] font-medium text-ink-800">{title ?? 'Drop a CSV, XML, Excel or PDF file here, or click to choose'}</span>
        <span className="text-[12px] text-ink-500">
          You map the columns and review every row before anything is written. A PDF is kept as a document and linked to a stakeholder or instrument.
        </span>
      </label>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[12px] text-ink-500">
        <span>Templates:</span>
        <button className="font-medium text-brand-600 hover:text-brand-700" onClick={() => void template('csv')}>CSV</button>
        <button className="font-medium text-brand-600 hover:text-brand-700" onClick={() => void template('xml')}>XML</button>
        <span className="text-ink-300">·</span>
        <span>Excel exports from other cap table tools work as they are.</span>
      </div>
    </div>
  );
}
