import { AlertCircle } from "lucide-react";

interface FriendlyErrorProps {
  message: string;
  title?: string;
  action?: string;
  className?: string;
}

export default function FriendlyError({ message, title = "A little snag", action, className = "" }: FriendlyErrorProps) {
  return (
    <div role="alert" className={`flex items-start gap-3 rounded-2xl border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container ${className}`}>
      <AlertCircle size={18} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-black">{title}</p>
        <p className="mt-0.5 leading-relaxed">{message}</p>
        {action && <p className="mt-1 font-bold">{action}</p>}
      </div>
    </div>
  );
}
