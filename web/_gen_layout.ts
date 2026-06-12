import { generateDeviceColumnLayout } from './src/layoutConfig.ts';
const layout = generateDeviceColumnLayout('src-remote-a', ['6c1','faa','1c9f','fae','fb8','fac','1ca7'], {
  title: '2025 Kashimadai',
  sensorLabels: { '1': 'Sensor 1: depth 0cm(Water)', '2': 'Sensor 2: depth 5cm', '3': 'Sensor 3: depth 10cm' },
  sensorColors: { '1': '#0044ff', '2': '#00cc00', '3': '#cccc00' },
  metrics: [
    { metric: 'battery_v', title: 'Battery voltage[V]', yMin: 2.0, yMax: 3.6 },
    { metric: 'temperature_c', title: 'Temperature[\u2103]', yMin: 10, yMax: 45 },
    { metric: 'ec_bulk_dsm', title: 'BulkEC[dS/m]' },
    { metric: 'vwc_pct', title: 'VWC[%]', yMin: 10, yMax: 70 },
    { metric: 'air_temp_c', title: 'Air Temperature[\u2103]', yMin: 10, yMax: 45 },
  ],
  batteryRanges: [2.0, 2.5, 3.0, 3.6],
});
console.log(JSON.stringify(layout, null, 2));
