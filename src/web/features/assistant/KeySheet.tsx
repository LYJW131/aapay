import { KeyRound, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { Hint } from '../../components/Hint.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { assistant } from '../../i18n/assistant.ts';
import { errorMessage } from '../../lib/api.ts';
import { setOwnKey, useOwnKey, verifyOwnKey } from './own-key.ts';

const t = assistant.key;

export function KeySheet({ open, onClose, builtin, model }: { open: boolean; onClose: () => void; builtin: boolean; model: string }) {
  return (
    <Sheet open={open} onClose={onClose} title={t.title} description={builtin ? t.descriptionSite : t.descriptionNone}>
      {open && <KeyForm defaultModel={model} onDone={onClose} />}
    </Sheet>
  );
}

function KeyForm({ defaultModel, onDone }: { defaultModel: string; onDone: () => void }) {
  const own = useOwnKey();
  const [key, setKey] = useState(own?.key ?? '');
  const [model, setModel] = useState(own?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const next = { key: key.trim(), model: model.trim().toLowerCase() || null };
    if (!next.key) return;
    setBusy(true);
    setError(null);
    try {
      await verifyOwnKey(next);
      setOwnKey(next);
      toast.success(t.saved);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function remove() {
    setOwnKey(null);
    toast(t.removed);
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-5 pt-1 pb-1">
      <div>
        <Label
          aside={
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-brand-600 hover:underline dark:text-brand-300">
              {t.get}
            </a>
          }
        >
          <span className="flex items-center gap-1.5">
            {t.label}
            <Hint>{t.stored}</Hint>
          </span>
        </Label>
        <input
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setError(null);
          }}
          placeholder={t.placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          className="field font-mono aria-invalid:ring-2 aria-invalid:ring-rose-500/60"
        />
        {error && <p className="mt-2 text-[13px] text-rose-600 dark:text-rose-400">{error}</p>}
      </div>
      <div>
        <Label>{t.model}</Label>
        <input
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setError(null);
          }}
          placeholder={defaultModel}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="field font-mono"
        />
      </div>
      <div className="flex gap-2">
        {own && (
          <Button variant="danger" size="lg" onClick={remove} icon={<Trash2 className="size-4" />}>
            {t.remove}
          </Button>
        )}
        <Button type="submit" variant="primary" size="lg" className="flex-1" loading={busy} disabled={!key.trim()} icon={<KeyRound className="size-4" />}>
          {t.save}
        </Button>
      </div>
    </form>
  );
}
