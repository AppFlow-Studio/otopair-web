export type InspectionOption = {
  value: string;
  label: string;
  aliases?: string[];
};

export const OTHER_INSPECTION_OPTION = "__other__";

export function resolveInspectionOption(
  value: string | null | undefined,
  options: InspectionOption[],
): InspectionOption | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    options.find((option) => {
      const candidates = [option.value, option.label, ...(option.aliases ?? [])];
      return candidates.some(
        (candidate) =>
          candidate.trim().toLowerCase().replace(/\s+/g, " ") === normalized,
      );
    }) ?? null
  );
}

export const TIRE_BRAND_OPTIONS: InspectionOption[] = [
  { value: "goodyear", label: "Goodyear" },
  { value: "michelin", label: "Michelin" },
  { value: "bridgestone", label: "Bridgestone" },
  { value: "firestone", label: "Firestone" },
  { value: "continental", label: "Continental" },
  { value: "pirelli", label: "Pirelli" },
  { value: "cooper", label: "Cooper" },
  { value: "hankook", label: "Hankook" },
  { value: "yokohama", label: "Yokohama" },
  {
    value: "bfgoodrich",
    label: "BFGoodrich",
    aliases: ["bf goodrich", "b.f. goodrich"],
  },
  { value: "toyo", label: "Toyo" },
  { value: "falken", label: "Falken" },
  { value: "general", label: "General" },
  { value: "kumho", label: "Kumho" },
  { value: "dunlop", label: "Dunlop" },
  { value: "nitto", label: "Nitto" },
  { value: "nexen", label: "Nexen" },
  { value: "mastercraft", label: "Mastercraft" },
  { value: "sumitomo", label: "Sumitomo" },
];

export const TIRE_MODEL_OPTIONS: InspectionOption[] = [
  { value: "michelin_defender", label: "Michelin Defender", aliases: ["defender", "defender t+h", "defender ltx m/s"] },
  { value: "michelin_crossclimate2", label: "Michelin CrossClimate2", aliases: ["crossclimate", "crossclimate 2", "cc2"] },
  { value: "michelin_pilot_sport_4s", label: "Michelin Pilot Sport 4S", aliases: ["ps4s", "pilot sport 4s"] },
  { value: "michelin_pilot_sport_as", label: "Michelin Pilot Sport A/S", aliases: ["pilot sport as", "ps as"] },
  { value: "michelin_primacy", label: "Michelin Primacy", aliases: ["primacy", "primacy mxm4", "primacy tour"] },
  { value: "continental_truecontact", label: "Continental TrueContact Tour", aliases: ["truecontact", "true contact"] },
  {
    value: "continental_extremecontact_dws06",
    label: "Continental ExtremeContact DWS06+",
    aliases: ["dws06", "extremecontact dws"],
  },
  { value: "continental_purecontact_ls", label: "Continental PureContact LS", aliases: ["purecontact"] },
  { value: "continental_procontact", label: "Continental ProContact", aliases: ["procontact"] },
  { value: "bridgestone_turanza", label: "Bridgestone Turanza", aliases: ["turanza"] },
  { value: "bridgestone_potenza", label: "Bridgestone Potenza", aliases: ["potenza", "potenza re980", "potenza s007"] },
  { value: "bridgestone_blizzak", label: "Bridgestone Blizzak", aliases: ["blizzak", "blizzak ws90"] },
  { value: "bridgestone_dueler", label: "Bridgestone Dueler", aliases: ["dueler", "dueler h/l"] },
  {
    value: "goodyear_assurance_weatherready",
    label: "Goodyear Assurance WeatherReady",
    aliases: ["assurance weatherready", "weatherready"],
  },
  { value: "goodyear_eagle_sport", label: "Goodyear Eagle Sport", aliases: ["eagle sport", "eagle f1"] },
  { value: "goodyear_wrangler", label: "Goodyear Wrangler", aliases: ["wrangler", "wrangler trailrunner"] },
  { value: "pirelli_pzero", label: "Pirelli P Zero", aliases: ["pzero", "p zero"] },
  { value: "pirelli_cinturato_p7", label: "Pirelli Cinturato P7", aliases: ["cinturato", "cinturato p7"] },
  { value: "pirelli_scorpion", label: "Pirelli Scorpion", aliases: ["scorpion", "scorpion verde"] },
  { value: "hankook_kinergy", label: "Hankook Kinergy", aliases: ["kinergy", "kinergy gt", "kinergy pt"] },
  { value: "hankook_ventus", label: "Hankook Ventus", aliases: ["ventus", "ventus v12"] },
  { value: "hankook_dynapro", label: "Hankook Dynapro", aliases: ["dynapro"] },
  { value: "yokohama_avid_ascend", label: "Yokohama Avid Ascend", aliases: ["avid ascend", "avid ascend gt"] },
  { value: "yokohama_geolandar", label: "Yokohama Geolandar", aliases: ["geolandar"] },
  { value: "yokohama_advan", label: "Yokohama Advan", aliases: ["advan", "advan sport"] },
  { value: "toyo_proxes", label: "Toyo Proxes", aliases: ["proxes", "proxes sport"] },
  { value: "toyo_open_country", label: "Toyo Open Country", aliases: ["open country", "open country at"] },
  { value: "falken_azenis", label: "Falken Azenis", aliases: ["azenis", "azenis fk510"] },
  { value: "falken_wildpeak", label: "Falken Wildpeak", aliases: ["wildpeak", "wildpeak at3w"] },
  { value: "bfg_advantage_ta", label: "BFGoodrich Advantage T/A", aliases: ["advantage ta", "advantage t/a"] },
  { value: "bfg_at_ko2", label: "BFGoodrich All-Terrain T/A KO2", aliases: ["ko2", "at ko2", "all terrain ko2"] },
  { value: "cooper_discoverer", label: "Cooper Discoverer", aliases: ["discoverer", "discoverer at3"] },
  { value: "general_altimax", label: "General AltiMAX", aliases: ["altimax", "altimax rt43"] },
];

export function tireModelOptionsForBrand(
  brand: string | null | undefined,
): InspectionOption[] {
  const brandValue = resolveInspectionOption(brand, TIRE_BRAND_OPTIONS)?.value;
  if (!brandValue) return [];
  const modelPrefix = brandValue === "bfgoodrich" ? "bfg" : brandValue;
  return TIRE_MODEL_OPTIONS.filter((option) =>
    option.value.startsWith(`${modelPrefix}_`),
  );
}

export const TIRE_SIZE_OPTIONS: InspectionOption[] = [
  "195/65R15",
  "205/55R16",
  "215/55R17",
  "215/60R16",
  "225/45R17",
  "225/45R18",
  "225/50R17",
  "225/55R17",
  "225/60R17",
  "235/45R18",
  "235/55R18",
  "235/60R18",
  "245/40R18",
  "245/40R19",
  "245/45R18",
  "245/45R19",
  "255/35R19",
  "255/40R19",
  "255/45R20",
  "265/70R17",
  "275/35R19",
  "275/35R20",
  "275/40R19",
  "275/40R20",
  "275/45R20",
  "285/45R22",
  "295/35R21",
].map((size) => ({
  value: size,
  label: size,
  aliases: [
    size.replace(/(\d+)\/(\d+)R(\d+)/i, "$1 / $2 R $3"),
    size.toLowerCase(),
  ],
}));

export const BRAKE_PAD_BRAND_OPTIONS: InspectionOption[] = [
  { value: "akebono", label: "Akebono" },
  { value: "brembo", label: "Brembo" },
  { value: "ebc", label: "EBC" },
  { value: "wagner", label: "Wagner" },
  { value: "bosch", label: "Bosch" },
  { value: "raybestos", label: "Raybestos" },
  { value: "power_stop", label: "Power Stop", aliases: ["powerstop"] },
  { value: "hawk", label: "Hawk" },
  { value: "nrs_galvanized", label: "NRS Galvanized", aliases: ["nrs"] },
  { value: "acdelco", label: "ACDelco", aliases: ["ac delco", "ac-delco"] },
  { value: "motorcraft", label: "Motorcraft" },
  { value: "mopar", label: "Mopar" },
  { value: "stoptech", label: "StopTech", aliases: ["stop tech"] },
  { value: "centric", label: "Centric" },
  { value: "carquest", label: "Carquest" },
  { value: "napa", label: "NAPA" },
  { value: "oem", label: "OEM (vehicle brand)", aliases: ["oe", "factory"] },
];
