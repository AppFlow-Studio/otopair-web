"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { UserButton, useUser } from "@clerk/nextjs";
import {
  LayoutDashboard,
  Briefcase,
  Calendar,
  Users,
  Settings,
  Menu,
  X,
  ChevronDown,
  PlusCircle,
  List,
} from "lucide-react";
import { useState } from "react";

const sidebarLinks = [
  { href: "/schedule", label: "Schedule", icon: Calendar },
  { href: "/team", label: "Team", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

const jobsSubLinks = [
  { href: "/jobs/create", label: "Create Job", icon: PlusCircle },
  { href: "/jobs", label: "All Jobs", icon: List },
];

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { user } = useUser();
  const displayName = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isJobsActive = pathname === "/jobs" || pathname.startsWith("/jobs/");
  const [jobsOpen, setJobsOpen] = useState(isJobsActive);

  return (
    <div className="min-h-screen flex bg-gray-50">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200 flex flex-col transform transition-transform lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-200">
          <Image src="/logo.png" alt="Otopair" width={32} height={32} />
          <span className="text-lg font-semibold text-gray-900">Otopair</span>
          <button
            className="ml-auto lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {/* Dashboard */}
          <Link
            href="/dashboard"
            onClick={() => setSidebarOpen(false)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              pathname === "/dashboard" || pathname.startsWith("/dashboard/")
                ? "bg-blue-50 text-blue-700"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            <LayoutDashboard className="w-5 h-5" />
            Dashboard
          </Link>

          {/* Jobs accordion */}
          <div>
            <button
              onClick={() => setJobsOpen(!jobsOpen)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors w-full ${
                isJobsActive
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              <Briefcase className="w-5 h-5" />
              <span className="flex-1 text-left">Jobs</span>
              <ChevronDown
                className={`w-4 h-4 transition-transform duration-200 ${jobsOpen ? "rotate-180" : ""}`}
              />
            </button>
            <div
              className="overflow-hidden transition-all duration-200"
              style={{ maxHeight: jobsOpen ? "120px" : "0px" }}
            >
              <div className="mt-1 ml-4 space-y-1 border-l border-gray-200 pl-3">
                {jobsSubLinks.map((link) => {
                  const isActive =
                    link.href === "/jobs"
                      ? pathname === "/jobs"
                      : pathname === link.href || pathname.startsWith(link.href + "/");
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setSidebarOpen(false)}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        isActive
                          ? "bg-blue-50 text-blue-700"
                          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                      }`}
                    >
                      <link.icon className="w-4 h-4" />
                      {link.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Remaining links */}
          {sidebarLinks.map((link) => {
            const isActive = pathname === link.href || pathname.startsWith(link.href + "/");
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                <link.icon className="w-5 h-5" />
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="px-6 py-4 border-t border-gray-200 flex items-center gap-2.5">
          <UserButton />
          {displayName && (
            <span className="text-sm font-medium text-gray-700 truncate">{displayName}</span>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center gap-4 px-6 py-4 bg-white border-b border-gray-200 lg:hidden">
          <button onClick={() => setSidebarOpen(true)}>
            <Menu className="w-6 h-6 text-gray-600" />
          </button>
          <Image src="/logo.png" alt="Otopair" width={28} height={28} />
          <span className="text-base font-semibold text-gray-900">Otopair</span>
          <div className="ml-auto">
            <UserButton />
          </div>
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
