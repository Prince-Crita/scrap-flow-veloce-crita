/**
 * Public surface of the chart system.
 *
 * Pages import from here, never from ./primitives or ./scale directly, so the
 * internals can be reorganised without touching a single dashboard.
 */
export {
  ChartCard,
  Legend,
  BarChart,
  LineChart,
  PieChart,
  DonutChart,
  Sparkline,
  RankedBars,
  SplitBar,
  GroupedBarChart,
  StackedBarChart,
  EmptyChartState,
  LoadingChartState,
  type ChartDatum,
  type LineSeries,
} from "./primitives";

export {
  DEFAULT_BOX,
  PALETTE,
  colorAt,
  compact,
  niceMax,
  bucketBy,
  bucketLabel,
  weekKey,
  monthKey,
  type Granularity,
  type Box,
} from "./scale";
