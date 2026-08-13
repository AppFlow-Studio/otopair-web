import Image from "next/image";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
      <div className="mb-8">
        <Image src="/logo.png" alt="Otopair" width={64} height={64} />
      </div>
      {children}
    </div>
  );
}
