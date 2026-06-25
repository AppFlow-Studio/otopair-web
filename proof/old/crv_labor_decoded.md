# OLD CR-V labor — ardent-crab, config w5709tw8xm046cvdafrk6x5e9h86m5bx
# 27 rows, two un-reconciled sources, no gate. service_id decoded via services table.

| service | book_h | source | conf | empirical_h | sample | flag |
|---|---|---|---|---|---|---|
| oil_change | 0.28 | vdb_repair_estimates | 0.9 | 0.4 | 1 | |
| tire_rotation | 0.35 | vdb_repair_estimates | 0.9 | **1.15** | 1 | 20-min job at 69 min, conf 0.9 |
| filter_replacement | 0.6 | vdb_repair_estimates | 0.9 | — | 0 | |
| brake_fluid_flush | 0.7 | vdb_repair_estimates | 0.9 | — | 0 | |
| transmission_service | 0.5 | vdb_repair_estimates | 0.9 | — | 0 | |
| differential_service | 0.5 | vdb_repair_estimates | 0.9 | — | 0 | |
| spark_plugs | 0.5 | vdb_repair_estimates | 0.9 | **1.5** | 2 | empirical 3× book |
| coolant_flush | 0.7 | vdb_repair_estimates | 0.9 | — | 0 | |
| brake_pad_replacement | 1.5 | training_data | 0.75 | — | 0 | round guess |
| rotor_replacement | 2 | training_data | 0.75 | — | 0 | round guess |
| battery_replacement | 0.3 | training_data | 0.75 | 0.5 | 1 | |
| wheel_alignment | 1 | training_data | 0.75 | 1.5 | 1 | round guess |
| fuel_system_cleaning | 0.5 | training_data | 0.75 | — | 0 | |
| power_steering_flush | 0.75 | training_data | 0.45 | — | 0 | |
| battery_test | 0.2 | training_data | 0.45 | — | 0 | |
| tire_replacement | 1.25 | training_data | 0.45 | 0.75 | 2 | |
| tire_balance | 0.75 | training_data | 0.45 | — | 0 | |
| emissions_test | 0.3 | training_data | 0.45 | 1.0 | 2 | |
| state_inspection | 0.5 | training_data | 0.45 | — | 0 | |
| check_engine_light | 1 | training_data | 0.45 | — | 0 | |
| pre_purchase_inspection | 1.75 | training_data | 0.45 | — | 0 | |
| **diagnostic_scan** | 0.5 | training_data | 0.45 | **137.93** | 2 | **POISON: 30-min scan logged as 137 hours** |
| (+5 more training_data rows, conf 0.45) | | | | | | |

NEW equivalent (flippant-mink config xd7cvqybt6g1x5883x2p44dwes87bagk):
all quote-graded services = source `aggregated` with a `repairpal_motor` observation,
gate refuses to grade anything without a RepairPal/empirical anchor → the 137.93h row
cannot exist.
