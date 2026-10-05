import { UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { LIMITS } from '../../../shared/limits.ts';
import type { Member } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { connect } from '../../i18n/connect.ts';
import { api, errorMessage } from '../../lib/api.ts';
import { useLedger } from './context.tsx';
import { MemberChip, saveDefaultPayer } from './ExpenseForm.tsx';

const t = connect.welcome;

export function WelcomeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snapshot, store, key } = useLedger();
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  // 新成员会先进 snapshot 再关弹窗，添加期间沿用原列表，免得退场动画里先冒出一行「我是」
  const [frozen, setFrozen] = useState<Member[] | null>(null);
  const members = frozen ?? snapshot.members;
  const full = members.length >= LIMITS.members;

  function pick(id: string, label: string) {
    saveDefaultPayer(key('payer'), id);
    toast.success(t.defaultPayer(label));
    onClose();
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setAdding(true);
    setFrozen(snapshot.members);
    try {
      const message = await store.mutate(api.ledger.members.$post({ json: { name: name.trim() } }));
      if (message.event.type === 'member.saved') pick(message.event.member.id, message.event.member.name);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(false);
      setFrozen(null);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t.title(snapshot.ledger.name)} description={t.description}>
      <div className="space-y-5 pb-4">
        {members.length > 0 && (
          <div>
            <Label>{t.iAm}</Label>
            <div className="flex flex-wrap gap-2">
              {members.map((m) => (
                <MemberChip key={m.id} member={m} active={false} onClick={() => pick(m.id, m.name)} />
              ))}
            </div>
          </div>
        )}
        {!full && (
          <form onSubmit={add}>
            <Label>{members.length > 0 ? t.notListed : t.addYourself}</Label>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={LIMITS.memberName}
                placeholder={t.namePlaceholder}
                className="field"
              />
              <Button type="submit" variant="primary" loading={adding} disabled={!name.trim()} icon={<UserPlus className="size-4" />}>
                {t.add}
              </Button>
            </div>
          </form>
        )}
        <Button variant="ghost" className="w-full" onClick={onClose}>
          {t.skip}
        </Button>
      </div>
    </Sheet>
  );
}
