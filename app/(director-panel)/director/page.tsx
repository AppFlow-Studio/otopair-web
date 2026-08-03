import { AdminPanel } from './AdminPanel'

export default function DirectorPage() {
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Inter', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
        .mono { font-family: 'JetBrains Mono', ui-monospace, monospace !important; }

        /* Enrichment Console (Direction B) — live telemetry motion */
        @keyframes omPulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }
        @keyframes omFlow { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }

        :root {
          --slate-25:  #F9FAFB;
          --slate-50:  #F8FAFC;
          --slate-100: #F1F5F9;
          --slate-200: #E2E8F0;
          --slate-300: #CBD5E1;
          --slate-400: #94A3B8;
          --slate-500: #64748B;
          --slate-600: #475569;
          --slate-700: #334155;
          --slate-800: #1E293B;
          --slate-900: #0F172A;

          --blue-50:   #EFF6FF;
          --blue-100:  #DBEAFE;
          --blue-500:  #3B82F6;
          --blue-600:  #2563EB;
          --blue-700:  #1D4ED8;

          --green-50:  #F0FDF4;
          --green-100: #DCFCE7;
          --green-600: #16A34A;
          --green-700: #15803D;

          --red-50:    #FEF2F2;
          --red-100:   #FEE2E2;
          --red-600:   #DC2626;
          --red-700:   #B91C1C;

          --yellow-50:  #FEFCE8;
          --yellow-200: #FEF08A;
          --yellow-800: #854D0E;

          --orange-50:  #FFF7ED;
          --orange-100: #FFEDD5;
          --orange-700: #C2410C;

          --purple-50:  #FAF5FF;
          --purple-700: #7E22CE;

          --indigo-50:  #EEF2FF;
          --indigo-700: #4338CA;

          --teal-50:    #F0FDFA;
          --teal-700:   #0F766E;
        }
      `}</style>
      <AdminPanel />
    </>
  )
}
