/**
 * lib/vdbCache.ts — Hardcoded VDB responses for VINs we've already decoded.
 * Checked before hitting the API. Saves credits and works when quota is exhausted.
 */

export const VDB_CACHE: Record<string, any> = {
  "3VV5B7AX9RM230023": {
    vin: "3VV5B7AX9RM230023",
    year: 2024,
    make: "Volkswagen",
    model: "Tiguan",
    trim: "2.0T SE R Line Black",
    style: "4dr All Wheel Drive 4MOTION",
    vehicle: { body_type: "SUV", doors: "4" },
    specifications: [
      { steering: { type: "Rack-Pinion" } },
      { braking: { type: "4-Wheel Disc", primary_abs_system: "4-Wheel", front_disc: "Yes", rear_disc: "Yes" } },
      { electrical: { cold_cranking_capacity_amps: "360" } },
      { tires: { front_tire_size: "P235/50HR19", rear_tire_size: "P235/50HR19", front_tire_pressure_psi: "33", rear_tire_pressure_psi: "33" } },
      { engine: { type: "Intercooled Turbo Regular Unleaded N/A", code: "", displacement: 2000, drivetype: "AWD", block_type: "I", cam_type: "DOHC" } },
      { fuel: { type: "Gasoline" } },
    ],
    dimensions: [
      { braking: [
        { front_brake_rotor_dia: [{ value: "13.4", unit: "in" }] },
        { rear_brake_rotor_dia: [{ value: "11.8", unit: "in" }] },
      ]},
      { wheels: [
        { wheel_torque: [{ value: "103", unit: "lb.ft" }] },
      ]},
      { engine: [
        { engine_size: [{ value: 2, unit: "l" }] },
      ]},
    ],
    transmission: {
      type: "Automatic",
      number_of_speeds: "8",
      description: "8-Speed Automatic w/Tiptronic",
    },
    standard_options: [
      { name: "Engine", description: "2.0L TSI DOHC 16-Valve Turbocharged 4-Cyl" },
      { name: "Transmission", description: "8-Speed Automatic w/Tiptronic" },
    ],
  },
};
