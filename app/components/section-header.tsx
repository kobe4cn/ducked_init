// app/components/section-header.tsx —— 面板里一个分区的标题：h2、可选的状态与一段说明
export function SectionHeader({ title, status, children }: { title: string; status?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h2 className="flex items-center gap-3 text-lg font-semibold">{title}{status}</h2>
      {children && <p className="max-w-2xl text-sm text-slate-500">{children}</p>}
    </div>
  );
}
