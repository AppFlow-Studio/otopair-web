import Image from "next/image";

/**
 * Hero helpers for the secondary pages, all server-safe (plain markup):
 * `HeroPhoto` for a real photograph cropped to the plate (`aspect` matches
 * the hero shape: 5/4 split, 2/1 stacked), and the service icon set with a
 * slug-to-icon lookup for the catalog pages. Every image here is one that
 * already ships in public/; nothing is generated or hand-drawn.
 */
type Aspect = "5/4" | "2/1";
const ASPECT: Record<Aspect, string> = { "5/4": "aspect-[5/4]", "2/1": "aspect-[2/1]" };

export function HeroPhoto({
  src,
  alt,
  width,
  height,
  position = "50% 50%",
  aspect = "5/4",
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  /** CSS object-position, so a wide photo can keep its subject in frame. */
  position?: string;
  aspect?: Aspect;
}) {
  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      priority
      sizes={aspect === "2/1" ? "(min-width: 1280px) 1190px, 100vw" : "(min-width: 1024px) 560px, 100vw"}
      className={`${ASPECT[aspect]} w-full object-cover`}
      style={{ objectPosition: position }}
    />
  );
}

/** The landing's six app icons, in catalog order. */
export const SERVICE_ICONS = [
  { src: "/images/landing/app/oilchangeicon.png", alt: "Oil change", w: 604, h: 406 },
  { src: "/images/landing/app/tiresicon.png", alt: "Tires", w: 604, h: 406 },
  { src: "/images/landing/app/brakesicon.png", alt: "Brakes", w: 604, h: 406 },
  { src: "/images/landing/app/batteryicon.png", alt: "Battery", w: 604, h: 406 },
  { src: "/images/landing/app/Engineicon.png", alt: "Engine and drivetrain", w: 604, h: 406 },
  { src: "/images/landing/app/inspection.png", alt: "Inspection", w: 526, h: 282 },
] as const;

/** Which of the six icons stands for a catalog service, by slug. */
export function serviceIcon(slug: string): (typeof SERVICE_ICONS)[number] {
  if (slug.startsWith("oil") || slug.startsWith("filter")) return SERVICE_ICONS[0];
  if (slug.startsWith("tire") || slug === "wheel_alignment") return SERVICE_ICONS[1];
  if (slug.startsWith("brake") || slug === "rotor_replacement") return SERVICE_ICONS[2];
  if (slug.startsWith("battery")) return SERVICE_ICONS[3];
  if (slug === "state_inspection" || slug === "emissions_test") return SERVICE_ICONS[5];
  return SERVICE_ICONS[4];
}
