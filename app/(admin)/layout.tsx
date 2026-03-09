"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import {
  LayoutDashboard,
  Users,
  Store,
  Briefcase,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";

const sidebarLinks = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/shops", label: "Shops", icon: Store },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
        className={`fixed lg:static inset-y-0 left-0 z-50 w-64 bg-gray-900 text-white flex flex-col transform transition-transform lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-700">
          <Image src="/logo.png" alt="Otopair" width={32} height={32} />
          <span className="text-lg font-semibold">Admin Panel</span>
          <button
            className="ml-auto lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {sidebarLinks.map((link) => {
            const isActive =
              pathname === link.href ||
              (link.href !== "/admin" && pathname.startsWith(link.href));
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-gray-700 text-white"
                    : "text-gray-400 hover:bg-gray-800 hover:text-white"
                }`}
              >
                <link.icon className="w-5 h-5" />
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="px-6 py-4 border-t border-gray-700">
          <UserButton />
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 flex items-center gap-4 px-6 py-4 bg-white border-b border-gray-200 lg:hidden">
          <button onClick={() => setSidebarOpen(true)}>
            <Menu className="w-6 h-6 text-gray-600" />
          </button>
          <span className="text-base font-semibold text-gray-900">
            Admin Panel
          </span>
          <div className="ml-auto">
            <UserButton />
          </div>
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
