import { redirect } from "next/navigation";

// Notification preferences moved to the dedicated /notifications page
// (Preferences tab). Keep this route as a permanent redirect so old links,
// bookmarks, and the bell footer's historical target still land correctly.
export default function NotificationSettingsRedirect() {
  redirect("/notifications?tab=preferences");
}
