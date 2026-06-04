"use client";

import { CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";

interface NotificationEmptyStateProps {
  onClose?: () => void;
}

export function NotificationEmptyState({
  onClose,
}: NotificationEmptyStateProps) {
  const router = useRouter();

  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-50">
        <CheckCircle2 className="h-7 w-7 text-green-600" strokeWidth={2} />
      </div>
      <p className="mt-4 text-sm font-semibold text-gray-900">
        You&apos;re all caught up
      </p>
      <p className="mt-1 max-w-[260px] text-xs text-gray-500">
        New booking requests and quote requests will appear here.
      </p>
      <button
        type="button"
        onClick={() => {
          onClose?.();
          router.push("/settings/notifications");
        }}
        className="mt-4 inline-flex items-center rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
      >
        View notification settings
      </button>
    </div>
  );
}
