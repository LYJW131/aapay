import { Plus, Trash2, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { LIMITS } from '../../../shared/limits.ts';
import type { Member } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { Button } from '../../components/Button.tsx';
import { Card, Label } from '../../components/Card.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { api, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { useLedger } from './context.tsx';

const EMOJIS = ['🐱', '🐶', '🦊', '🐼', '🐨', '🐯', '🦁', '🐸', '🐵', '🐧', '🦄', '🐙', '😀', '😎', '🥳', '🤓', '👻', '🌝'];

export function MembersCard() {
  const { snapshot, store } = useLedger();
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setAdding(true);
    try {
      await store.mutate(api.ledger.members.$post({ json: { name: name.trim() } }));
      setName('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Card title="成员" icon={<Users />} action={<span className="tabular text-xs text-zinc-400">{snapshot.members.length} 人</span>}>
      {snapshot.members.length > 0 && (
        <div className="-mx-1 mb-4 flex flex-wrap gap-1">
          {snapshot.members.map((m) => (
            <button
              key={m.id}
              onClick={() => setEditing(m)}
              className="group flex w-[60px] flex-col items-center gap-1 rounded-2xl py-1.5 transition hover:bg-zinc-900/4 dark:hover:bg-white/5"
              title={`编辑 ${m.name}`}
            >
              <Avatar member={m} className="transition group-active:scale-90" />
              <span className="w-full truncate px-0.5 text-center text-xs text-zinc-600 dark:text-zinc-300">{m.name}</span>
            </button>
          ))}
        </div>
      )}
      <form onSubmit={add} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={LIMITS.memberName}
          placeholder={snapshot.members.length ? '添加新成员' : '先添加一起记账的人'}
          className="field"
          aria-label="新成员名字"
        />
        <Button type="submit" variant="soft" size="icon" className="size-11 rounded-2xl" loading={adding} aria-label="添加成员">
          {!adding && <Plus className="size-5" />}
        </Button>
      </form>
      <MemberSheet member={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function MemberSheet({ member, onClose }: { member: Member | null; onClose: () => void }) {
  return (
    <Sheet open={!!member} onClose={onClose} title="编辑成员">
      {member && <MemberEditor key={member.id} member={member} onDone={onClose} />}
    </Sheet>
  );
}

function MemberEditor({ member, onDone }: { member: Member; onDone: () => void }) {
  const { store, snapshot } = useLedger();
  const [name, setName] = useState(member.name);
  const [avatar, setAvatar] = useState(member.avatar);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const used =
    snapshot.expenses.some((e) => e.payerId === member.id || e.shares.some((s) => s.memberId === member.id)) ||
    snapshot.settlements.some((s) => s.fromId === member.id || s.toId === member.id);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === member.name && avatar === member.avatar) return onDone();
    setBusy('save');
    try {
      await store.mutate(api.ledger.members[':id'].$patch({ param: { id: member.id }, json: { name: name.trim(), avatar } }));
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('delete');
    try {
      await store.mutate(api.ledger.members[':id'].$delete({ param: { id: member.id } }));
      toast.success(`已移除 ${member.name}`);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5 pb-1">
      <div className="flex justify-center pt-1">
        <Avatar member={{ ...member, avatar, name: name || member.name }} size="xl" />
      </div>
      <div>
        <Label>头像</Label>
        <div className="grid grid-cols-6 gap-2">
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setAvatar(e)}
              className={cn(
                'flex aspect-square items-center justify-center rounded-2xl text-2xl transition active:scale-90',
                avatar === e ? 'bg-brand-500/15 ring-2 ring-brand-500' : 'bg-zinc-100 hover:bg-zinc-200 dark:bg-white/6',
              )}
            >
              {e}
            </button>
          ))}
        </div>
        <input
          value={EMOJIS.includes(avatar) ? '' : avatar}
          onChange={(e) => setAvatar([...new Intl.Segmenter().segment(e.target.value)].at(-1)?.segment ?? '')}
          placeholder="或输入任意 emoji"
          className="field mt-2 text-center"
        />
      </div>
      <div>
        <Label>名字</Label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.memberName} className="field" />
      </div>
      <div className="flex gap-2">
        <Button
          variant="danger"
          size="lg"
          onClick={remove}
          loading={busy === 'delete'}
          disabled={used}
          title={used ? '该成员已有账目，无法删除' : undefined}
          icon={<Trash2 className="size-4" />}
        >
          移除
        </Button>
        <Button type="submit" variant="primary" size="lg" className="flex-1" loading={busy === 'save'}>
          保存
        </Button>
      </div>
      {used && <p className="text-center text-xs text-zinc-400">该成员已有账目记录，不能移除</p>}
    </form>
  );
}
