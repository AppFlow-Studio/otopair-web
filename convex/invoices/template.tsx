/**
 * Invoice PDF template — rendered server-side from a Convex Node action via
 * @react-pdf/renderer. The same `renderInvoiceToBuffer` output is stored in
 * Convex file storage AND attached to the Resend email, so what the customer
 * downloads from the mobile app is byte-identical to what landed in their
 * inbox.
 *
 * Layout follows a clean "client view" invoice (logo + business header, big
 * invoice title, a Customer / Invoice Details / Payment column band, an items
 * table, then Subtotal → Total). The brand mark is the shop's own logo when it
 * has one, otherwise the Otopair logo.
 */
"use node";

import * as React from "react";
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

export type InvoicePart = {
  name: string;
  oemNumber?: string | null;
  brand?: string | null;
  qty: number;
  unitCents: number;
  lineCents: number;
};

export type InvoiceData = {
  invoiceNumber: string;
  issuedAtMs: number;
  status: "paid" | "refunded";

  customer: { name: string; email: string; phone?: string | null };
  vehicle: {
    year?: number | null;
    make?: string | null;
    model?: string | null;
    trim?: string | null;
    vin?: string | null;
    licensePlate?: string | null;
    mileage?: number | null;
  };
  shop: {
    name: string;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    logoUrl?: string | null;
  };
  mechanicName?: string | null;

  services: string[];
  parts: InvoicePart[];

  laborMinutes: number;
  laborCents: number;
  partsTotalCents: number;
  subtotalCents: number;
  taxCents?: number | null;
  platformFeeCents?: number | null;
  totalCents: number;

  refundedCents?: number | null;
  refundedAtMs?: number | null;

  stripeChargeId?: string | null;
};

// Hosted Otopair brand mark (same asset the transactional emails use). Used as
// the header logo when the shop hasn't uploaded its own.
const OTOPAIR_LOGO_URL = "https://otopair.com/logo.png";

const NEUTRAL_900 = "#111827";
const NEUTRAL_700 = "#374151";
const NEUTRAL_500 = "#6b7280";
const NEUTRAL_400 = "#9ca3af";
const NEUTRAL_300 = "#d1d5db";
const NEUTRAL_200 = "#e5e7eb";
const NEUTRAL_100 = "#f3f4f6";
const LOGO_BG = "#1f2937";

const styles = StyleSheet.create({
  page: {
    paddingTop: 48,
    paddingBottom: 56,
    paddingHorizontal: 48,
    fontSize: 10,
    color: NEUTRAL_900,
    fontFamily: "Helvetica",
    backgroundColor: "#ffffff",
  },

  // ── Header: logo + business (left), invoice no. + issue date (right) ──
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    maxWidth: 360,
  },
  logoBox: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: LOGO_BG,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  logoImg: {
    width: 44,
    height: 44,
    objectFit: "contain",
  },
  businessName: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_900,
  },
  businessMeta: {
    marginTop: 2,
    fontSize: 8.5,
    color: NEUTRAL_500,
    lineHeight: 1.4,
  },
  headerRight: {
    alignItems: "flex-end",
  },
  headerInvoiceNo: {
    fontSize: 9,
    color: NEUTRAL_500,
  },
  headerIssueLabel: {
    marginTop: 10,
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_700,
  },
  headerIssueDate: {
    marginTop: 1,
    fontSize: 9,
    color: NEUTRAL_500,
  },

  rule: {
    height: 3,
    backgroundColor: NEUTRAL_400,
    borderRadius: 2,
    marginTop: 22,
    marginBottom: 26,
  },

  title: {
    fontSize: 24,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_900,
    letterSpacing: -0.6,
    marginBottom: 22,
  },

  // ── Customer / Invoice Details / Payment band ──
  band: {
    flexDirection: "row",
    gap: 20,
    borderTopWidth: 1,
    borderTopColor: NEUTRAL_200,
    borderBottomWidth: 1,
    borderBottomColor: NEUTRAL_200,
    paddingVertical: 16,
    marginBottom: 24,
  },
  bandCol: {
    flex: 1,
  },
  bandLabel: {
    fontSize: 9.5,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_900,
    marginBottom: 6,
  },
  bandBody: {
    fontSize: 9.5,
    color: NEUTRAL_700,
    lineHeight: 1.5,
  },

  // ── Items table ──
  tableHeader: {
    flexDirection: "row",
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: NEUTRAL_300,
  },
  th: {
    fontSize: 9.5,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_900,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: NEUTRAL_100,
  },
  colItem: { flex: 4 },
  colQty: { flex: 1.2, textAlign: "right" },
  colPrice: { flex: 1.6, textAlign: "right" },
  colAmount: { flex: 1.6, textAlign: "right" },
  itemName: {
    fontSize: 10,
    color: NEUTRAL_900,
  },
  itemSub: {
    marginTop: 2,
    fontSize: 8,
    color: NEUTRAL_500,
  },
  cell: {
    fontSize: 10,
    color: NEUTRAL_700,
  },

  // ── Totals ──
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 10,
    paddingBottom: 2,
  },
  totalsLabel: { fontSize: 10, color: NEUTRAL_700 },
  totalsValue: { fontSize: 10, color: NEUTRAL_900 },
  grandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 6,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: NEUTRAL_200,
  },
  grandLabel: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_900,
  },
  grandValue: {
    fontSize: 18,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_900,
  },
  refundRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  refundText: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: "#92400e",
  },

  footer: {
    position: "absolute",
    left: 48,
    right: 48,
    bottom: 28,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: NEUTRAL_200,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: {
    fontSize: 8,
    color: NEUTRAL_400,
  },
});

function formatCents(c: number): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatLaborTime(minutes: number): string {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function vehicleTitle(v: InvoiceData["vehicle"]): string {
  return [v.year, v.make, v.model, v.trim]
    .filter((x): x is string | number => x != null && x !== "")
    .map(String)
    .join(" ");
}

function Invoice({ data }: { data: InvoiceData }) {
  const vt = vehicleTitle(data.vehicle);
  const isRefunded = data.status === "refunded";
  const logoUrl = data.shop.logoUrl || OTOPAIR_LOGO_URL;
  const usingShopLogo = Boolean(data.shop.logoUrl);
  const businessContact = [data.shop.email, data.shop.phone]
    .filter((x): x is string => Boolean(x))
    .join("  |  ");
  const paymentLine = isRefunded
    ? `Refunded ${data.refundedAtMs ? formatDate(data.refundedAtMs) : ""}`.trim()
    : `Paid ${formatDate(data.issuedAtMs)}`;

  return (
    <Document
      title={`${data.shop.name} Invoice ${data.invoiceNumber}`}
      author={data.shop.name}
      subject={`Invoice ${data.invoiceNumber}`}
    >
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View
              style={[
                styles.logoBox,
                usingShopLogo ? { backgroundColor: "#ffffff" } : {},
              ]}
            >
              <Image src={logoUrl} style={styles.logoImg} />
            </View>
            <View>
              <Text style={styles.businessName}>{data.shop.name}</Text>
              {businessContact ? (
                <Text style={styles.businessMeta}>{businessContact}</Text>
              ) : null}
              {data.shop.address ? (
                <Text style={styles.businessMeta}>{data.shop.address}</Text>
              ) : null}
            </View>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.headerInvoiceNo}>
              Invoice {data.invoiceNumber}
            </Text>
            <Text style={styles.headerIssueLabel}>Issue date</Text>
            <Text style={styles.headerIssueDate}>
              {formatDate(data.issuedAtMs)}
            </Text>
          </View>
        </View>

        <View style={styles.rule} />

        <Text style={styles.title}>Invoice {data.invoiceNumber}</Text>

        {/* Customer / Invoice Details / Payment band */}
        <View style={styles.band}>
          <View style={styles.bandCol}>
            <Text style={styles.bandLabel}>Customer</Text>
            <Text style={styles.bandBody}>
              {data.customer.name}
              {data.customer.email ? `\n${data.customer.email}` : ""}
              {data.customer.phone ? `\n${data.customer.phone}` : ""}
              {vt ? `\n${vt}` : ""}
              {data.vehicle.vin ? `\nVIN ${data.vehicle.vin}` : ""}
            </Text>
          </View>
          <View style={styles.bandCol}>
            <Text style={styles.bandLabel}>Invoice Details</Text>
            <Text style={styles.bandBody}>
              PDF created {formatDate(data.issuedAtMs)}
              {"\n"}
              {formatCents(data.totalCents)}
              {data.mechanicName ? `\nTechnician · ${data.mechanicName}` : ""}
            </Text>
          </View>
          <View style={styles.bandCol}>
            <Text style={styles.bandLabel}>Payment</Text>
            <Text style={styles.bandBody}>
              {paymentLine}
              {"\n"}
              {formatCents(isRefunded ? data.refundedCents ?? 0 : data.totalCents)}
            </Text>
          </View>
        </View>

        {/* Items table */}
        <View style={styles.tableHeader}>
          <Text style={[styles.th, styles.colItem]}>Items</Text>
          <Text style={[styles.th, styles.colQty]}>Quantity</Text>
          <Text style={[styles.th, styles.colPrice]}>Price</Text>
          <Text style={[styles.th, styles.colAmount]}>Amount</Text>
        </View>

        {data.parts.map((p, i) => (
          <View key={i} style={styles.row}>
            <View style={styles.colItem}>
              <Text style={styles.itemName}>{p.name}</Text>
              {p.brand || p.oemNumber ? (
                <Text style={styles.itemSub}>
                  {[p.brand, p.oemNumber].filter(Boolean).join(" · ")}
                </Text>
              ) : null}
            </View>
            <Text style={[styles.cell, styles.colQty]}>{p.qty}</Text>
            <Text style={[styles.cell, styles.colPrice]}>
              {formatCents(p.unitCents)}
            </Text>
            <Text style={[styles.cell, styles.colAmount]}>
              {formatCents(p.lineCents)}
            </Text>
          </View>
        ))}

        {data.laborCents > 0 || data.laborMinutes > 0 ? (
          <View style={styles.row}>
            <View style={styles.colItem}>
              <Text style={styles.itemName}>Labor</Text>
              {formatLaborTime(data.laborMinutes) ? (
                <Text style={styles.itemSub}>
                  {formatLaborTime(data.laborMinutes)}
                </Text>
              ) : null}
            </View>
            <Text style={[styles.cell, styles.colQty]}>—</Text>
            <Text style={[styles.cell, styles.colPrice]}>—</Text>
            <Text style={[styles.cell, styles.colAmount]}>
              {formatCents(data.laborCents)}
            </Text>
          </View>
        ) : null}

        {/* Totals */}
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Subtotal</Text>
          <Text style={styles.totalsValue}>
            {formatCents(data.subtotalCents)}
          </Text>
        </View>
        {data.taxCents != null && data.taxCents > 0 ? (
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Tax</Text>
            <Text style={styles.totalsValue}>{formatCents(data.taxCents)}</Text>
          </View>
        ) : null}
        {data.platformFeeCents != null && data.platformFeeCents > 0 ? (
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Service fee</Text>
            <Text style={styles.totalsValue}>
              {formatCents(data.platformFeeCents)}
            </Text>
          </View>
        ) : null}

        <View style={styles.grandRow}>
          <Text style={styles.grandLabel}>Total</Text>
          <Text style={styles.grandValue}>{formatCents(data.totalCents)}</Text>
        </View>

        {isRefunded && data.refundedCents ? (
          <View style={styles.refundRow}>
            <Text style={styles.refundText}>
              Refunded
              {data.refundedAtMs ? ` · ${formatDate(data.refundedAtMs)}` : ""}
            </Text>
            <Text style={styles.refundText}>
              −{formatCents(data.refundedCents)}
            </Text>
          </View>
        ) : null}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {[data.shop.name, data.shop.website]
              .filter((x): x is string => Boolean(x))
              .join(" · ")}
          </Text>
          <Text style={styles.footerText}>
            {data.invoiceNumber}
            {data.vehicle.vin ? ` · VIN ${data.vehicle.vin}` : ""} · Powered by
            Otopair
          </Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderInvoiceToBuffer(
  data: InvoiceData,
): Promise<Buffer> {
  return await renderToBuffer(<Invoice data={data} />);
}
