# OLP Labor Probe — Results (2026-06-13)

Source: openlaborproject.com Next.js data routes (buildId `9LcCyZqhNWcZKlN9hHFXY`). Read-only probe — no DB writes. Spec: `docs/superpowers/specs/2026-06-12-olp-labor-probe-design.md`.

## Headline

- Configs probed: **18** — resolved on OLP: **17** (94%)
- Service comparisons with both sides present: **201**
- Median |Δ| OLP vs our book_hours: **23%** — within ±25%: **56%**
- OLP-has / we-don't: **5** · we-have / OLP-doesn't: **4**

### Reading these numbers

The disagreement is **directional and structural, not random noise**: OLP reads
lower than our book_hours in 112 of the 201 matched comparisons (higher in 54).
Three known scope mismatches drive most of it — `oil_change` (OLP's row is a
synthetic-oil-only change, ours is the bundled service; −40…−50% on nearly every
car), `differential_service` (OLP's "service" row vs our fluid-change-anchored
hours; +65% median), and `timing_belt` (n=2 — chain engines correctly have no
OLP row, so the sample is two cars). The per-service medians below are the
right lens; the pooled 23% headline mixes these scope mismatches with genuinely
aligned services like `brake_pad_replacement` and `filter_replacement` (Δ=0%).

## Resolution per config


| Config                                                     | OLP vehicle                                                                                               | Labor entries | Services matched         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------- | ------------------------ |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`                  | [2020 4.4L V8 Twin-Turbo N63](https://openlaborproject.com/portal/bmw/m550i/2020/4.4l-v8-twin-turbo-n63/) | 566           | 12/13                    |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl`     | [2022 3.6L V6](https://openlaborproject.com/portal/volkswagen/atlas/2022/3.6l-v6/)                        | 564           | 12/13                    |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`                | [2022 3.6L V6](https://openlaborproject.com/portal/volkswagen/atlas/2022/3.6l-v6/)                        | 564           | 11/13                    |
| `2022_volkswagen_jetta_s_ea211`                            | [2022 1.4L I4 TSI](https://openlaborproject.com/portal/volkswagen/jetta/2022/1.4l-i4-tsi/)                | 566           | 12/13                    |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`                  | [2020 1.4L I4 TSI](https://openlaborproject.com/portal/volkswagen/jetta/2020/1.4l-i4-tsi/)                | 566           | 12/13                    |
| `9999_evaltest_crosstenantfixture_base_1.5l_4cyl_gasoline` | —                                                                                                         | —             | ✗ model not found on OLP |
| `2016_honda_cr_v_se_k24w9`                                 | [2016 2.4L I4](https://openlaborproject.com/portal/honda/cr-v/2016/2.4l-i4/)                              | 564           | 12/13                    |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`                  | [2021 4.4L V8 Twin-Turbo N63](https://openlaborproject.com/portal/bmw/m550i/2021/4.4l-v8-twin-turbo-n63/) | 566           | 12/13                    |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`                   | [2020 4.4L V8 Twin-Turbo N63](https://openlaborproject.com/portal/bmw/750i/2020/4.4l-v8-twin-turbo-n63/)  | 566           | 12/13                    |
| `2003_honda_accord_ex_j30a4`                               | [2003 3.0L V6 J30](https://openlaborproject.com/portal/honda/accord/2003/3.0l-v6-j30/)                    | 563           | 12/13                    |
| `2018_honda_civic_lx_k20c2`                                | [2018 2.0L I4](https://openlaborproject.com/portal/honda/civic/2018/2.0l-i4/)                             | 564           | 11/13                    |
| `2026_ford_expedition_tremor_gtdi_high`                    | [2026 3.5L V6 EcoBoost](https://openlaborproject.com/portal/ford/expedition/2026/3.5l-v6-ecoboost/)       | 566           | 12/13                    |
| `2023_nissan_rogue_sv_engine`                              | [2023 1.5L I3 Turbo](https://openlaborproject.com/portal/nissan/rogue/2023/1.5l-i3-turbo/)                | 566           | 11/13                    |
| `2022_toyota_rav4_le_a25a_fxs`                             | [2022 2.5L I4 PHEV](https://openlaborproject.com/portal/toyota/rav4/2022/2.5l-i4-phev/)                   | 607           | 12/13                    |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`          | [2020 2.0L Turbo I4](https://openlaborproject.com/portal/volvo/xc90/2020/2.0l-turbo-i4/)                  | 565           | 13/13                    |
| `2018_porsche_911_turbo_s_ma1_76`                          | [2018 3.8L H6](https://openlaborproject.com/portal/porsche/911/2018/3.8l-h6/)                             | 564           | 12/13                    |
| `2020_honda_civic_sport_k20c2`                             | [2020 2.0L I4](https://openlaborproject.com/portal/honda/civic/2020/2.0l-i4/)                             | 564           | 11/13                    |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`               | [2018 2.0L Turbo I4](https://openlaborproject.com/portal/mercedes-benz/c-class/2018/2.0l-turbo-i4/)       | 566           | 12/13                    |


## Per-service medians (matched rows)


| Service               | n   | Our median h | OLP median h | Median Δ% |
| --------------------- | --- | ------------ | ------------ | --------- |
| battery_replacement   | 17  | 0.6          | 0.5          | -29%      |
| brake_fluid_flush     | 17  | 0.8          | 0.8          | -13%      |
| brake_pad_replacement | 17  | 1.2          | 1.2          | 0%        |
| coolant_flush         | 17  | 1.0          | 0.9          | -20%      |
| differential_service  | 12  | 1.0          | 1.3          | 65%       |
| filter_replacement    | 17  | 0.3          | 0.3          | 0%        |
| oil_change            | 17  | 0.6          | 0.3          | -40%      |
| power_steering_flush  | 17  | 0.8          | 0.6          | -20%      |
| rotor_replacement     | 17  | 2.0          | 1.8          | -10%      |
| spark_plugs           | 17  | 1.6          | 1.0          | -25%      |
| timing_belt           | 2   | 4.4          | 6.3          | 44%       |
| transmission_service  | 17  | 1.5          | 1.7          | 35%       |
| wheel_alignment       | 17  | 1.5          | 1.0          | -29%      |


## Full comparison (config × service)


| Config                                                 | Service               | Ours h | RP obs h | OLP h | Δ%   | Status       |
| ------------------------------------------------------ | --------------------- | ------ | -------- | ----- | ---- | ------------ |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | oil_change            | 0.6    | 0.6      | 0.5   | -17% | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | filter_replacement    | 0.5    | —        | 0.3   | -40% | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | spark_plugs           | 3.3    | 3.3      | 4.5   | 36%  | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | timing_belt           | —      | —        | —     | —    | both_missing |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | coolant_flush         | 1.5    | —        | 1.0   | -33% | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | transmission_service  | 1.5    | —        | 2.7   | 80%  | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | wheel_alignment       | 1.9    | 1.9      | 1.0   | -47% | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | brake_pad_replacement | 1.5    | 1.5      | 1.2   | -20% | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | rotor_replacement     | 1.5    | —        | 1.8   | 20%  | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | brake_fluid_flush     | 1.0    | —        | 0.8   | -20% | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | battery_replacement   | 1.3    | 1.3      | 0.6   | -54% | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | power_steering_flush  | 0.8    | —        | 0.9   | 20%  | matched      |
| `2020_bmw_5_series_m550i_xdrive_n63b44o2`              | differential_service  | 1.0    | —        | 1.8   | 80%  | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | oil_change            | 0.6    | 0.6      | 0.3   | -50% | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | filter_replacement    | 0.3    | —        | 0.3   | 0%   | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | spark_plugs           | 2.0    | 2.0      | 2.5   | 25%  | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | timing_belt           | —      | —        | —     | —    | both_missing |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | coolant_flush         | 1.0    | —        | 0.8   | -20% | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | transmission_service  | 2.0    | —        | 1.5   | -25% | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | wheel_alignment       | 1.5    | 1.5      | 1.0   | -33% | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | brake_pad_replacement | 1.2    | 1.2      | 1.2   | 0%   | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | rotor_replacement     | 2.0    | —        | 1.5   | -25% | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | brake_fluid_flush     | 1.0    | —        | 0.8   | -20% | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | battery_replacement   | 0.7    | 0.7      | 0.5   | -29% | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | power_steering_flush  | 0.8    | —        | 0.5   | -33% | matched      |
| `2022_volkswagen_atlas_v6_se_w_technology_3_6l_3_6cyl` | differential_service  | 1.0    | —        | 1.0   | 0%   | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | oil_change            | 0.6    | 0.6      | 0.3   | -50% | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | filter_replacement    | 0.3    | —        | 0.3   | 0%   | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | spark_plugs           | 2.0    | 2.0      | 2.5   | 25%  | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | timing_belt           | —      | —        | —     | —    | both_missing |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | coolant_flush         | 1.0    | —        | 0.8   | -20% | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | transmission_service  | 1.5    | —        | 1.5   | 0%   | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | wheel_alignment       | 1.5    | 1.5      | 1.0   | -33% | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | brake_pad_replacement | 1.2    | 1.2      | 1.2   | 0%   | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | rotor_replacement     | 2.0    | —        | 1.5   | -25% | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | brake_fluid_flush     | 1.0    | —        | 0.8   | -20% | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | battery_replacement   | 0.7    | 0.7      | 0.5   | -29% | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | power_steering_flush  | 0.8    | —        | 0.5   | -33% | matched      |
| `2022_volkswagen_atlas_2_0t_se_3_6l_3_6cyl`            | differential_service  | —      | —        | 1.0   | —    | no_our_data  |
| `2022_volkswagen_jetta_s_ea211`                        | oil_change            | 0.6    | 0.6      | 0.3   | -50% | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | filter_replacement    | 0.3    | —        | 0.3   | 0%   | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | spark_plugs           | 1.6    | 1.6      | 0.9   | -44% | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | timing_belt           | 7.0    | 7.0      | —     | —    | no_olp_job   |
| `2022_volkswagen_jetta_s_ea211`                        | coolant_flush         | 1.0    | —        | 0.9   | -10% | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | transmission_service  | 1.5    | —        | 1.7   | 13%  | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | wheel_alignment       | 1.7    | 1.7      | 1.2   | -29% | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | brake_pad_replacement | 1.3    | 1.3      | 1.4   | 8%   | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | rotor_replacement     | 2.0    | —        | 1.8   | -10% | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | brake_fluid_flush     | 0.8    | —        | 0.9   | 12%  | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | battery_replacement   | 0.6    | 0.6      | 0.5   | -17% | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | power_steering_flush  | 0.8    | —        | 0.6   | -20% | matched      |
| `2022_volkswagen_jetta_s_ea211`                        | differential_service  | 0.2    | —        | 1.2   | 422% | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | oil_change            | 0.6    | 0.6      | 0.3   | -50% | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | filter_replacement    | 0.3    | —        | 0.3   | 0%   | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | spark_plugs           | 1.3    | 1.3      | 0.9   | -31% | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | timing_belt           | 7.6    | 7.6      | —     | —    | no_olp_job   |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | coolant_flush         | 1.0    | —        | 0.9   | -10% | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | transmission_service  | 1.5    | —        | 1.7   | 13%  | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | wheel_alignment       | 1.7    | 1.7      | 1.2   | -29% | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | brake_pad_replacement | 1.3    | 1.3      | 1.4   | 8%   | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | rotor_replacement     | 2.0    | —        | 1.8   | -10% | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | brake_fluid_flush     | 0.8    | —        | 0.9   | 12%  | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | battery_replacement   | 0.6    | 0.6      | 0.5   | -17% | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | power_steering_flush  | 0.8    | —        | 0.6   | -20% | matched      |
| `2020_volkswagen_jetta_1_4t_r_line_ea211`              | differential_service  | 0.2    | —        | 1.2   | 500% | matched      |
| `2016_honda_cr_v_se_k24w9`                             | oil_change            | 0.5    | 0.5      | 0.3   | -40% | matched      |
| `2016_honda_cr_v_se_k24w9`                             | filter_replacement    | 0.3    | —        | 0.2   | -33% | matched      |
| `2016_honda_cr_v_se_k24w9`                             | spark_plugs           | 0.6    | 0.6      | 0.8   | 33%  | matched      |
| `2016_honda_cr_v_se_k24w9`                             | timing_belt           | 3.7    | 3.7      | —     | —    | no_olp_job   |
| `2016_honda_cr_v_se_k24w9`                             | coolant_flush         | 1.0    | —        | 0.8   | -20% | matched      |
| `2016_honda_cr_v_se_k24w9`                             | transmission_service  | 0.8    | —        | 1.5   | 87%  | matched      |
| `2016_honda_cr_v_se_k24w9`                             | wheel_alignment       | 1.2    | 1.2      | 1.0   | -17% | matched      |
| `2016_honda_cr_v_se_k24w9`                             | brake_pad_replacement | 1.0    | 1.0      | 1.0   | 0%   | matched      |
| `2016_honda_cr_v_se_k24w9`                             | rotor_replacement     | 1.5    | —        | 1.5   | 0%   | matched      |
| `2016_honda_cr_v_se_k24w9`                             | brake_fluid_flush     | 0.8    | —        | 0.6   | -25% | matched      |
| `2016_honda_cr_v_se_k24w9`                             | battery_replacement   | 0.5    | 0.5      | 0.3   | -40% | matched      |
| `2016_honda_cr_v_se_k24w9`                             | power_steering_flush  | 0.8    | —        | 0.5   | -33% | matched      |
| `2016_honda_cr_v_se_k24w9`                             | differential_service  | 0.5    | —        | 1.0   | 100% | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | oil_change            | 0.5    | 0.5      | 0.5   | 0%   | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | filter_replacement    | 0.5    | —        | 0.3   | -40% | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | spark_plugs           | 4.2    | 4.2      | 4.5   | 7%   | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | timing_belt           | —      | —        | —     | —    | both_missing |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | coolant_flush         | 1.5    | —        | 1.0   | -33% | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | transmission_service  | 2.0    | —        | 2.7   | 35%  | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | wheel_alignment       | 1.9    | 1.9      | 1.0   | -47% | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | brake_pad_replacement | 1.5    | 1.5      | 1.2   | -20% | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | rotor_replacement     | 2.0    | —        | 1.8   | -10% | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | brake_fluid_flush     | 1.0    | —        | 0.8   | -20% | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | battery_replacement   | 0.7    | 0.7      | 0.6   | -14% | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | power_steering_flush  | 0.8    | —        | 0.9   | 20%  | matched      |
| `2021_bmw_5_series_m550i_xdrive_n63b44t4`              | differential_service  | 1.0    | —        | 1.8   | 80%  | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | oil_change            | 0.5    | 0.5      | 0.5   | 0%   | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | filter_replacement    | 0.5    | —        | 0.3   | -40% | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | spark_plugs           | 4.2    | 4.2      | 4.5   | 7%   | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | timing_belt           | —      | —        | —     | —    | both_missing |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | coolant_flush         | 1.5    | —        | 1.0   | -33% | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | transmission_service  | 2.0    | —        | 2.7   | 35%  | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | wheel_alignment       | 1.5    | 1.5      | 1.0   | -33% | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | brake_pad_replacement | 1.2    | 1.2      | 1.2   | 0%   | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | rotor_replacement     | 1.5    | —        | 1.8   | 20%  | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | brake_fluid_flush     | 1.0    | —        | 0.8   | -20% | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | battery_replacement   | 0.5    | 0.5      | 0.6   | 20%  | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | power_steering_flush  | 0.8    | —        | 0.9   | 20%  | matched      |
| `2020_bmw_7_series_750i_xdrive_n63b44o2`               | differential_service  | 1.0    | —        | 1.8   | 80%  | matched      |
| `2003_honda_accord_ex_j30a4`                           | oil_change            | 0.6    | 0.6      | 0.3   | -50% | matched      |
| `2003_honda_accord_ex_j30a4`                           | filter_replacement    | 0.5    | —        | 0.3   | -40% | matched      |
| `2003_honda_accord_ex_j30a4`                           | spark_plugs           | 0.5    | 0.5      | 0.8   | 60%  | matched      |
| `2003_honda_accord_ex_j30a4`                           | timing_belt           | 4.6    | 4.6      | 5.0   | 9%   | matched      |
| `2003_honda_accord_ex_j30a4`                           | coolant_flush         | 0.7    | —        | 0.8   | 14%  | matched      |
| `2003_honda_accord_ex_j30a4`                           | transmission_service  | 0.5    | —        | 1.5   | 200% | matched      |
| `2003_honda_accord_ex_j30a4`                           | wheel_alignment       | 1.3    | 1.3      | 1.0   | -23% | matched      |
| `2003_honda_accord_ex_j30a4`                           | brake_pad_replacement | 1.0    | 1.0      | 1.2   | 20%  | matched      |
| `2003_honda_accord_ex_j30a4`                           | rotor_replacement     | 1.5    | —        | 2.0   | 33%  | matched      |
| `2003_honda_accord_ex_j30a4`                           | brake_fluid_flush     | 0.7    | —        | 0.8   | 14%  | matched      |
| `2003_honda_accord_ex_j30a4`                           | battery_replacement   | 0.4    | 0.3      | 0.4   | 0%   | matched      |
| `2003_honda_accord_ex_j30a4`                           | power_steering_flush  | 0.5    | —        | 0.5   | 0%   | matched      |
| `2003_honda_accord_ex_j30a4`                           | differential_service  | —      | —        | 1.0   | —    | no_our_data  |
| `2018_honda_civic_lx_k20c2`                            | oil_change            | 0.6    | 0.6      | 0.3   | -50% | matched      |
| `2018_honda_civic_lx_k20c2`                            | filter_replacement    | 0.2    | —        | 0.2   | 0%   | matched      |
| `2018_honda_civic_lx_k20c2`                            | spark_plugs           | 1.3    | 1.3      | 0.8   | -38% | matched      |
| `2018_honda_civic_lx_k20c2`                            | timing_belt           | 3.1    | 3.1      | —     | —    | no_olp_job   |
| `2018_honda_civic_lx_k20c2`                            | coolant_flush         | 1.0    | —        | 0.8   | -20% | matched      |
| `2018_honda_civic_lx_k20c2`                            | transmission_service  | 0.8    | —        | 1.5   | 87%  | matched      |
| `2018_honda_civic_lx_k20c2`                            | wheel_alignment       | 1.3    | 1.3      | 1.0   | -23% | matched      |
| `2018_honda_civic_lx_k20c2`                            | brake_pad_replacement | 1.0    | 1.0      | 1.0   | 0%   | matched      |
| `2018_honda_civic_lx_k20c2`                            | rotor_replacement     | 1.5    | —        | 1.5   | 0%   | matched      |
| `2018_honda_civic_lx_k20c2`                            | brake_fluid_flush     | 0.8    | —        | 0.7   | -13% | matched      |
| `2018_honda_civic_lx_k20c2`                            | battery_replacement   | 0.6    | 0.6      | 0.3   | -50% | matched      |
| `2018_honda_civic_lx_k20c2`                            | power_steering_flush  | 0.8    | —        | 0.5   | -33% | matched      |
| `2018_honda_civic_lx_k20c2`                            | differential_service  | —      | —        | 1.0   | —    | no_our_data  |
| `2026_ford_expedition_tremor_gtdi_high`                | oil_change            | 0.5    | 0.5      | 0.3   | -40% | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | filter_replacement    | 0.3    | —        | 0.2   | -33% | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | spark_plugs           | 2.6    | 2.6      | 1.5   | -42% | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | timing_belt           | —      | —        | —     | —    | both_missing |
| `2026_ford_expedition_tremor_gtdi_high`                | coolant_flush         | 1.0    | —        | 1.2   | 20%  | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | transmission_service  | 2.0    | —        | 1.7   | -15% | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | wheel_alignment       | 2.0    | 2.0      | 1.0   | -50% | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | brake_pad_replacement | 1.1    | 1.1      | 1.0   | -9%  | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | rotor_replacement     | 2.0    | —        | 1.2   | -40% | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | brake_fluid_flush     | 1.0    | —        | 0.8   | -20% | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | battery_replacement   | 0.4    | 0.3      | 0.3   | -25% | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | power_steering_flush  | 0.8    | —        | 0.6   | -20% | matched      |
| `2026_ford_expedition_tremor_gtdi_high`                | differential_service  | 0.8    | —        | 1.2   | 50%  | matched      |
| `2023_nissan_rogue_sv_engine`                          | oil_change            | 0.5    | 0.5      | 0.3   | -40% | matched      |
| `2023_nissan_rogue_sv_engine`                          | filter_replacement    | 0.3    | —        | 0.3   | 0%   | matched      |
| `2023_nissan_rogue_sv_engine`                          | spark_plugs           | 1.2    | 1.2      | 0.9   | -25% | matched      |
| `2023_nissan_rogue_sv_engine`                          | timing_belt           | —      | —        | —     | —    | both_missing |
| `2023_nissan_rogue_sv_engine`                          | coolant_flush         | 1.0    | —        | 0.9   | -10% | matched      |
| `2023_nissan_rogue_sv_engine`                          | transmission_service  | 1.0    | —        | 1.7   | 70%  | matched      |
| `2023_nissan_rogue_sv_engine`                          | wheel_alignment       | 1.6    | 1.6      | 1.2   | -25% | matched      |
| `2023_nissan_rogue_sv_engine`                          | brake_pad_replacement | 1.0    | 1.0      | 1.4   | 40%  | matched      |
| `2023_nissan_rogue_sv_engine`                          | rotor_replacement     | 2.0    | —        | 1.8   | -10% | matched      |
| `2023_nissan_rogue_sv_engine`                          | brake_fluid_flush     | 0.5    | —        | 0.9   | 80%  | matched      |
| `2023_nissan_rogue_sv_engine`                          | battery_replacement   | 0.5    | —        | 0.5   | 0%   | matched      |
| `2023_nissan_rogue_sv_engine`                          | power_steering_flush  | 0.8    | —        | 0.6   | -20% | matched      |
| `2023_nissan_rogue_sv_engine`                          | differential_service  | —      | —        | 1.2   | —    | no_our_data  |
| `2022_toyota_rav4_le_a25a_fxs`                         | oil_change            | 0.6    | 0.6      | 0.3   | -50% | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | filter_replacement    | 0.3    | —        | 0.3   | 0%   | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | spark_plugs           | 1.2    | 1.2      | 0.8   | -33% | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | timing_belt           | —      | —        | —     | —    | both_missing |
| `2022_toyota_rav4_le_a25a_fxs`                         | coolant_flush         | 1.0    | —        | 0.8   | -20% | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | transmission_service  | 1.0    | —        | 1.5   | 50%  | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | wheel_alignment       | 2.3    | 2.3      | 1.0   | -57% | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | brake_pad_replacement | 0.9    | 0.9      | 1.2   | 33%  | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | rotor_replacement     | 2.0    | —        | 2.0   | 0%   | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | brake_fluid_flush     | 0.8    | —        | 0.8   | 0%   | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | battery_replacement   | 0.6    | 0.6      | 0.4   | -33% | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | power_steering_flush  | 0.8    | —        | 0.5   | -33% | matched      |
| `2022_toyota_rav4_le_a25a_fxs`                         | differential_service  | 1.0    | —        | 1.0   | 0%   | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | oil_change            | 0.6    | 0.6      | 0.4   | -33% | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | filter_replacement    | 0.3    | —        | 0.2   | -33% | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | spark_plugs           | 1.0    | 1.0      | 1.2   | 20%  | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | timing_belt           | 4.2    | 4.2      | 7.5   | 79%  | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | coolant_flush         | 1.0    | —        | 1.0   | 0%   | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | transmission_service  | 1.5    | —        | 2.2   | 47%  | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | wheel_alignment       | 1.4    | 1.4      | 1.0   | -29% | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | brake_pad_replacement | 1.3    | 1.3      | 1.0   | -23% | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | rotor_replacement     | 2.0    | —        | 1.5   | -25% | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | brake_fluid_flush     | 0.8    | —        | 0.8   | 0%   | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | battery_replacement   | 0.9    | 0.9      | 0.5   | -44% | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | power_steering_flush  | 0.8    | —        | 0.7   | -7%  | matched      |
| `2020_volvo_xc90_t6_momentum_7_passenger_b4204ts`      | differential_service  | 1.0    | —        | 1.5   | 50%  | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | oil_change            | 0.5    | 0.5      | 0.4   | -20% | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | filter_replacement    | 0.5    | —        | 0.4   | -20% | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | spark_plugs           | 3.0    | 3.0      | 1.0   | -67% | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | timing_belt           | —      | —        | —     | —    | both_missing |
| `2018_porsche_911_turbo_s_ma1_76`                      | coolant_flush         | 1.5    | —        | 1.0   | -33% | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | transmission_service  | 1.5    | —        | 2.0   | 33%  | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | wheel_alignment       | 2.3    | 2.3      | 1.3   | -43% | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | brake_pad_replacement | 1.2    | 1.2      | 1.6   | 33%  | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | rotor_replacement     | 2.0    | —        | 2.0   | 0%   | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | brake_fluid_flush     | 1.0    | —        | 1.0   | 0%   | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | battery_replacement   | 1.2    | 1.2      | 0.5   | -58% | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | power_steering_flush  | 0.8    | —        | 0.7   | -7%  | matched      |
| `2018_porsche_911_turbo_s_ma1_76`                      | differential_service  | 1.0    | —        | 1.3   | 30%  | matched      |
| `2020_honda_civic_sport_k20c2`                         | oil_change            | 0.6    | 0.6      | 0.3   | -50% | matched      |
| `2020_honda_civic_sport_k20c2`                         | filter_replacement    | 0.2    | —        | 0.2   | 0%   | matched      |
| `2020_honda_civic_sport_k20c2`                         | spark_plugs           | 1.3    | 1.3      | 0.8   | -38% | matched      |
| `2020_honda_civic_sport_k20c2`                         | timing_belt           | —      | —        | —     | —    | both_missing |
| `2020_honda_civic_sport_k20c2`                         | coolant_flush         | 1.0    | —        | 0.8   | -20% | matched      |
| `2020_honda_civic_sport_k20c2`                         | transmission_service  | 0.8    | —        | 1.5   | 87%  | matched      |
| `2020_honda_civic_sport_k20c2`                         | wheel_alignment       | 1.3    | 1.3      | 1.0   | -23% | matched      |
| `2020_honda_civic_sport_k20c2`                         | brake_pad_replacement | 1.0    | 1.0      | 1.0   | 0%   | matched      |
| `2020_honda_civic_sport_k20c2`                         | rotor_replacement     | 1.5    | —        | 1.5   | 0%   | matched      |
| `2020_honda_civic_sport_k20c2`                         | brake_fluid_flush     | 0.8    | —        | 0.7   | -13% | matched      |
| `2020_honda_civic_sport_k20c2`                         | battery_replacement   | 0.6    | 0.6      | 0.3   | -50% | matched      |
| `2020_honda_civic_sport_k20c2`                         | power_steering_flush  | 0.8    | —        | 0.5   | -33% | matched      |
| `2020_honda_civic_sport_k20c2`                         | differential_service  | —      | —        | 1.0   | —    | no_our_data  |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | oil_change            | 0.6    | 0.6      | 0.4   | -33% | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | filter_replacement    | 0.3    | —        | 0.3   | 0%   | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | spark_plugs           | 4.6    | 4.6      | 1.5   | -67% | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | timing_belt           | —      | —        | —     | —    | both_missing |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | coolant_flush         | 1.0    | —        | 1.2   | 20%  | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | transmission_service  | 2.0    | —        | 2.2   | 10%  | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | wheel_alignment       | 1.0    | —        | 1.0   | 0%   | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | brake_pad_replacement | 1.5    | —        | 1.2   | -20% | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | rotor_replacement     | 2.0    | —        | 1.5   | -25% | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | brake_fluid_flush     | 0.8    | —        | 0.8   | 0%   | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | battery_replacement   | 0.5    | —        | 0.5   | 0%   | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | power_steering_flush  | 0.8    | —        | 0.7   | -7%  | matched      |
| `2018_mercedes_benz_c_class_amg_c_63_s_m177`           | differential_service  | 1.0    | —        | 1.5   | 50%  | matched      |


## Gaps

**Cars OLP couldn't resolve (1):** `9999_evaltest_crosstenantfixture_base_1.5l_4cyl_gasoline`

**Services with zero OLP coverage across all cars:** none