/**
 * Invoice PDF template — rendered server-side from a Convex Node action via
 * @react-pdf/renderer. The same `renderInvoiceToBuffer` output is stored in
 * Convex file storage AND attached to the Resend email, so what the customer
 * downloads from the mobile app is byte-identical to what landed in their
 * inbox.
 */
"use node";

import * as React from "react";
import {
  Document,
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

  customer: { name: string; email: string };
  vehicle: {
    year?: number | null;
    make?: string | null;
    model?: string | null;
    trim?: string | null;
    vin?: string | null;
  };
  shop: {
    name: string;
    address?: string | null;
    phone?: string | null;
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

const BRAND_PRIMARY = "#0d72ff";
const BRAND_DARK = "#0a4fbf";
const NEUTRAL_900 = "#111827";
const NEUTRAL_700 = "#374151";
const NEUTRAL_500 = "#6b7280";
const NEUTRAL_300 = "#d1d5db";
const NEUTRAL_100 = "#f3f4f6";
const NEUTRAL_50 = "#f9fafb";

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
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 28,
  },
  brand: {
    flexDirection: "column",
  },
  brandMark: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    color: BRAND_PRIMARY,
    letterSpacing: -0.4,
  },
  brandTagline: {
    marginTop: 4,
    fontSize: 9,
    color: NEUTRAL_500,
  },
  invoiceMeta: {
    alignItems: "flex-end",
  },
  invoiceTitle: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_900,
    letterSpacing: -0.4,
  },
  invoiceNumber: {
    marginTop: 4,
    fontSize: 10,
    color: NEUTRAL_700,
  },
  statusPill: {
    marginTop: 8,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statusPaid: {
    backgroundColor: "#dcfce7",
    color: "#166534",
  },
  statusRefunded: {
    backgroundColor: "#fef3c7",
    color: "#92400e",
  },
  twoCol: {
    flexDirection: "row",
    gap: 24,
    marginBottom: 28,
  },
  block: {
    flex: 1,
  },
  blockLabel: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_500,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  blockBody: {
    fontSize: 10,
    color: NEUTRAL_900,
    lineHeight: 1.5,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_900,
    marginBottom: 8,
  },
  table: {
    borderTopWidth: 1,
    borderTopColor: NEUTRAL_300,
    marginBottom: 18,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: NEUTRAL_50,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: NEUTRAL_300,
  },
  tableHeaderCell: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_500,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: NEUTRAL_100,
  },
  colPart: { flex: 3 },
  colOem: { flex: 2 },
  colQty: { flex: 1, textAlign: "right" },
  colUnit: { flex: 1.4, textAlign: "right" },
  colLine: { flex: 1.4, textAlign: "right" },
  partName: {
    fontSize: 10,
    color: NEUTRAL_900,
  },
  partBrand: {
    marginTop: 2,
    fontSize: 8,
    color: NEUTRAL_500,
  },
  mono: {
    fontFamily: "Courier",
    fontSize: 9,
    color: NEUTRAL_700,
  },
  amount: {
    fontSize: 10,
    color: NEUTRAL_900,
  },
  totalsBox: {
    marginLeft: "auto",
    width: 260,
  },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 5,
  },
  totalsLabel: {
    color: NEUTRAL_500,
  },
  totalsValue: {
    color: NEUTRAL_900,
  },
  grandTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 10,
    marginTop: 6,
    borderTopWidth: 1.5,
    borderTopColor: NEUTRAL_900,
  },
  grandTotalLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
    color: NEUTRAL_900,
  },
  grandTotalValue: {
    fontFamily: "Helvetica-Bold",
    fontSize: 13,
    color: NEUTRAL_900,
  },
  refundRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 8,
    marginTop: 4,
    color: "#92400e",
  },
  refundLabel: {
    color: "#92400e",
    fontFamily: "Helvetica-Bold",
  },
  refundValue: {
    color: "#92400e",
    fontFamily: "Helvetica-Bold",
  },
  servicesList: {
    flexDirection: "column",
    gap: 4,
    marginBottom: 18,
  },
  serviceItem: {
    fontSize: 10,
    color: NEUTRAL_900,
  },
  laborRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: NEUTRAL_100,
  },
  footer: {
    position: "absolute",
    left: 48,
    right: 48,
    bottom: 28,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: NEUTRAL_300,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: {
    fontSize: 8,
    color: NEUTRAL_500,
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
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatLaborTime(minutes: number): string {
  if (!minutes || minutes <= 0) return "—";
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
  return (
    <Document
      title={`Otopair Invoice ${data.invoiceNumber}`}
      author="Otopair"
      subject={`Invoice ${data.invoiceNumber}`}
    >
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <Text style={styles.brandMark}>Otopair</Text>
            <Text style={styles.brandTagline}>
              The future of car repair coordination
            </Text>
          </View>
          <View style={styles.invoiceMeta}>
            <Text style={styles.invoiceTitle}>INVOICE</Text>
            <Text style={styles.invoiceNumber}>{data.invoiceNumber}</Text>
            <Text style={styles.invoiceNumber}>
              Issued {formatDate(data.issuedAtMs)}
            </Text>
            <Text
              style={[
                styles.statusPill,
                isRefunded ? styles.statusRefunded : styles.statusPaid,
              ]}
            >
              {isRefunded ? "Refunded" : "Paid"}
            </Text>
          </View>
        </View>

        <View style={styles.twoCol}>
          <View style={styles.block}>
            <Text style={styles.blockLabel}>Bill to</Text>
            <Text style={styles.blockBody}>
              {data.customer.name}
              {"\n"}
              {data.customer.email}
              {vt ? `\n${vt}` : ""}
              {data.vehicle.vin ? `\nVIN · ${data.vehicle.vin}` : ""}
            </Text>
          </View>
          <View style={styles.block}>
            <Text style={styles.blockLabel}>Serviced by</Text>
            <Text style={styles.blockBody}>
              {data.shop.name}
              {data.shop.address ? `\n${data.shop.address}` : ""}
              {data.shop.phone ? `\n${data.shop.phone}` : ""}
              {data.mechanicName ? `\nMechanic · ${data.mechanicName}` : ""}
            </Text>
          </View>
        </View>

        {data.services.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Services</Text>
            <View style={styles.servicesList}>
              {data.services.map((s, i) => (
                <Text key={i} style={styles.serviceItem}>
                  • {s}
                </Text>
              ))}
            </View>
          </>
        ) : null}

        <Text style={styles.sectionTitle}>Parts & labor</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, styles.colPart]}>Part</Text>
            <Text style={[styles.tableHeaderCell, styles.colOem]}>OEM #</Text>
            <Text style={[styles.tableHeaderCell, styles.colQty]}>Qty</Text>
            <Text style={[styles.tableHeaderCell, styles.colUnit]}>Unit</Text>
            <Text style={[styles.tableHeaderCell, styles.colLine]}>Line</Text>
          </View>

          {data.parts.length === 0 ? (
            <View style={styles.tableRow}>
              <Text style={[styles.partName, { color: NEUTRAL_500 }]}>
                No parts on this job
              </Text>
            </View>
          ) : (
            data.parts.map((p, i) => (
              <View key={i} style={styles.tableRow}>
                <View style={styles.colPart}>
                  <Text style={styles.partName}>{p.name}</Text>
                  {p.brand ? (
                    <Text style={styles.partBrand}>{p.brand}</Text>
                  ) : null}
                </View>
                <Text style={[styles.mono, styles.colOem]}>
                  {p.oemNumber ?? "—"}
                </Text>
                <Text style={[styles.amount, styles.colQty]}>{p.qty}</Text>
                <Text style={[styles.amount, styles.colUnit]}>
                  {formatCents(p.unitCents)}
                </Text>
                <Text style={[styles.amount, styles.colLine]}>
                  {formatCents(p.lineCents)}
                </Text>
              </View>
            ))
          )}

          <View style={styles.laborRow}>
            <Text style={styles.partName}>
              Labor · {formatLaborTime(data.laborMinutes)}
            </Text>
            <Text style={styles.amount}>{formatCents(data.laborCents)}</Text>
          </View>
        </View>

        <View style={styles.totalsBox}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Parts subtotal</Text>
            <Text style={styles.totalsValue}>
              {formatCents(data.partsTotalCents)}
            </Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Labor</Text>
            <Text style={styles.totalsValue}>
              {formatCents(data.laborCents)}
            </Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Subtotal</Text>
            <Text style={styles.totalsValue}>
              {formatCents(data.subtotalCents)}
            </Text>
          </View>
          {data.taxCents != null && data.taxCents > 0 ? (
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>Tax</Text>
              <Text style={styles.totalsValue}>
                {formatCents(data.taxCents)}
              </Text>
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
          <View style={styles.grandTotalRow}>
            <Text style={styles.grandTotalLabel}>Total charged</Text>
            <Text style={styles.grandTotalValue}>
              {formatCents(data.totalCents)}
            </Text>
          </View>
          {isRefunded && data.refundedCents ? (
            <View style={styles.refundRow}>
              <Text style={styles.refundLabel}>
                Refunded
                {data.refundedAtMs
                  ? ` · ${formatDate(data.refundedAtMs)}`
                  : ""}
              </Text>
              <Text style={styles.refundValue}>
                −{formatCents(data.refundedCents)}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Otopair · info@otopair.com · otopair.com
          </Text>
          <Text style={styles.footerText}>
            {data.stripeChargeId
              ? `Payment ref · ${data.stripeChargeId.slice(-12)}`
              : ""}
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
