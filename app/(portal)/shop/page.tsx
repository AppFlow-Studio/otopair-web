"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { MapPin, Phone, Globe, Mail, ExternalLink } from "lucide-react";

export default function ShopPage() {
  const shops = useQuery(api.shops.getMyShops);

  if (shops === undefined) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Shop</h1>
        <p className="text-gray-600 mb-8">Manage your shop profile and settings.</p>
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-gray-400 text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  const shop = shops[0] ?? null;

  if (!shop) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Shop</h1>
        <p className="text-gray-600 mb-8">Manage your shop profile and settings.</p>

        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            No shop configured yet
          </h2>
          <p className="text-gray-500 mb-6">
            Set up your shop to start accepting bookings and managing your team.
          </p>
          <Link
            href="/shop/setup"
            className="inline-flex items-center px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Set Up Shop
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">{shop.name}</h1>
          <p className="text-gray-500 text-sm">/{shop.slug}</p>
        </div>
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
            shop.is_active
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-500"
          }`}
        >
          {shop.is_active ? "Active" : "Inactive"}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Contact & Location */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
            Location &amp; Contact
          </h2>
          <ul className="space-y-3">
            <li className="flex items-start gap-3 text-sm text-gray-700">
              <MapPin className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
              <span>
                {shop.address}
                <br />
                {shop.city}, {shop.state} {shop.zip}
              </span>
            </li>
            <li className="flex items-center gap-3 text-sm text-gray-700">
              <Phone className="w-4 h-4 text-gray-400 shrink-0" />
              <span>{shop.phone}</span>
            </li>
            {shop.email && (
              <li className="flex items-center gap-3 text-sm text-gray-700">
                <Mail className="w-4 h-4 text-gray-400 shrink-0" />
                <span>{shop.email}</span>
              </li>
            )}
            {shop.website && (
              <li className="flex items-center gap-3 text-sm">
                <Globe className="w-4 h-4 text-gray-400 shrink-0" />
                <a
                  href={shop.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline flex items-center gap-1"
                >
                  {shop.website}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </li>
            )}
          </ul>
        </div>

        {/* Description */}
        {shop.description && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
              About
            </h2>
            <p className="text-sm text-gray-700 leading-relaxed">
              {shop.description}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
