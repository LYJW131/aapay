import { ChevronDown } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { usePersistentState } from '../lib/hooks.ts';
import { Collapse } from './Collapse.tsx';

export function Card({
  id,
  title,
  icon,
  action,
  children,
  className,
  defaultCollapsed = false,
}: {
  id: string;
  title: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = usePersistentState(`aapay:card:${id}:collapsed`, defaultCollapsed);
  return (
    <section data-card={id} className={cn('card animate-fade-in p-5', className)}>
      <header
        className="flex min-h-8 cursor-pointer items-center justify-between gap-3 select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold tracking-tight">
          {icon && <span className="text-brand-500 dark:text-brand-300 [&>svg]:size-[18px]">{icon}</span>}
          {title}
          <motion.span animate={{ rotate: collapsed ? -90 : 0 }} transition={{ duration: 0.2 }} className="text-zinc-400">
            <ChevronDown className="size-4" />
          </motion.span>
        </h2>
        {action && <div onClick={(e) => e.stopPropagation()}>{action}</div>}
      </header>
      <Collapse open={!collapsed} className="pt-4">
        {children}
      </Collapse>
    </section>
  );
}

export function Empty({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl bg-zinc-50 px-4 py-10 text-center dark:bg-white/3">
      {icon && <div className="mb-3 text-zinc-300 dark:text-zinc-600 [&>svg]:size-9">{icon}</div>}
      <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{title}</p>
      {hint && <p className="mt-1 text-[13px] text-zinc-400 dark:text-zinc-500">{hint}</p>}
    </div>
  );
}

export function Label({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between text-[13px] font-medium text-zinc-500 dark:text-zinc-400">
      <span>{children}</span>
      {aside}
    </div>
  );
}
