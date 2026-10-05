import { UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { LIMITS } from '../../../shared/limits.ts';
import type { Member } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { api, errorMessage } from '../../lib/api.ts';
import { useLedger } from './context.tsx';
import { MemberChip, saveDefaultPayer } from './ExpenseForm.tsx';

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
    toast.success(`记账时默认由 ${label} 付款`);
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
    <Sheet open={open} onClose={onClose} title={`欢迎加入「${snapshot.ledger.name}」`} description="你是哪一位？之后记账会默认由你付款">
      <div className="space-y-5 pb-4">
        {members.length > 0 && (
          <div>
            <Label>我是</Label>
            <div className="flex flex-wrap gap-2">
              {members.map((m) => (
                <MemberChip key={m.id} member={m} active={false} onClick={() => pick(m.id, m.name)} />
              ))}
            </div>
          </div>
        )}
        {!full && (
          <form onSubmit={add}>
            <Label>{members.length > 0 ? '不在里面？把自己加进来' : '先把自己加进来'}</Label>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={LIMITS.memberName}
                placeholder="你的名字"
                className="field"
              />
              <Button type="submit" variant="primary" loading={adding} disabled={!name.trim()} icon={<UserPlus className="size-4" />}>
                添加
              </Button>
            </div>
          </form>
        )}
        <Button variant="ghost" className="w-full" onClick={onClose}>
          跳过
        </Button>
      </div>
    </Sheet>
  );
}
