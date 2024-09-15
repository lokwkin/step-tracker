import { ChartConfiguration } from 'chart.js';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

export type TimeMeta = {
    startTs: number;
    endTs: number;
    timeUsageMs?: number;
};

export type StepMeta = {
    key: string;
    time: TimeMeta;
    record: Record<string, any>;
    result: any;
};

export type RecordListener = (data: any) => void | Promise<void>;

export class StepTracker {
    
    public key: string;
    public records: Record<string, any>;
    public result?: any;
    public time: TimeMeta;
    private subtrackers: { [key: string]: StepTracker } = {};
    private ctx: StepTracker;
    private eventListeners: { [key: string]: RecordListener } = {};

    constructor(key: string, options?: {
        listeners: Record<string, RecordListener>
    } ) {
        this.key = key;
        this.records = {};
        this.time = {
            startTs: Date.now(),
            endTs: Date.now(),
            timeUsageMs: 0
        };
        if (options?.listeners) {
            this.eventListeners = options.listeners;
        }
        this.ctx = this;
    }

    private async run(callable: (st: StepTracker) => Promise<any>) {
        this.time.startTs = Date.now();
        try {
            this.result = await callable(this.ctx);
            return this.result;
        } catch (err) {
            throw err;
        } finally {
            this.time.endTs = Date.now();
            this.time.timeUsageMs = this.time.endTs - this.time.startTs;
        }
    }

    public async track<T>(callable: (st: StepTracker) => Promise<T>): Promise<T> {
        return await this.run(callable);
    }

    public async step<T>(key: string, callable: (st: StepTracker) => Promise<T>): Promise<T> {
        const subtracker = new StepTracker(`${this.key}.${key}`, { listeners: this.eventListeners });
        this.subtrackers[key] = subtracker;
        return await subtracker.run(callable);
    }

    public log(key: string, data: any) {
        // deprecated, use record instead
        console.warn('StepTracker.log() is deprecated, use StepTracker.record() instead');
        return this.record(key, data);
    }

    public async record(key: string, data: any) {
        this.records[key] = data;
        if (this.eventListeners[key]) {
            const listener  = this.eventListeners[key];
            await listener(data);
        }
        return this;
    }

    public output(): StepMeta & { substeps: StepMeta[] } {
        return {
            key: this.key,
            time: this.time,
            record: this.records,
            result: this.result,
            substeps: Object.values(this.subtrackers).map((subtracker) => subtracker.output())
        }
    }

    public outputFlattened(): StepMeta[] {
        const substeps = Object.values(this.subtrackers).map((subtracker) => subtracker.outputFlattened());
        return [{
            key: this.key,
            time: this.time,
            record: this.records,
            result: this.result,
        }].concat(substeps.flat());
    }

    /**
     * Generate a Gantt chart via QuickChart.io, returning an quickchart URL.
     */
    public ganttUrl(args?: {unit: 'ms' | 's', minWidth: number, minHeight: number, includeSteps?: RegExp | string[] }): string {

        const { unit, minWidth, minHeight, includeSteps } = {
            ...{ unit: 'ms', minWidth: 500, minHeight: 300 },
            ...(args ?? {}),
        };
        const substeps = includeSteps ? this.outputFlattened().filter((step) => {
            if (includeSteps instanceof RegExp) {
                return includeSteps.test(step.key);
            } else if (Array.isArray(includeSteps)) {
                return includeSteps.includes(step.key);
            }
            return true;
        }) : this.outputFlattened();

        const maxEndTs = Math.max(...substeps.map((step) => step.time.endTs));
  
        const chartData = {
            type: 'horizontalBar',
            data: {
                labels: substeps.map((step) => `${step.key} - ${(step.time.endTs - step.time.startTs) / (unit === 'ms' ? 1 : 1000)}${unit}`),
                datasets: [
                    {
                        data: substeps.map((step) => [
                            (step.time.startTs - this.time.startTs) / (unit === 'ms' ? 1 : 1000),
                            (step.time.endTs - this.time.startTs) / (unit === 'ms' ? 1 : 1000),
                        ]),
                    },
                ],
            },
            options: {
                legend: {
                    display: false,
                },
                scales: {
                    xAxes: [
                        {
                            position: 'top',
                            ticks: {
                                min: 0,
                                max: (maxEndTs - this.time.startTs) / (unit === 'ms' ? 1 : 1000),
                            },
                        },
                    ],
                },
            },
        };
  
        const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartData))}&w=${Math.max(minWidth, substeps.length * 25)}&h=${Math.max(minHeight, substeps.length * 25)}`;
        return chartUrl;
    }

    /**
     * Generate a Gantt chart locally via ChartJS, returning a Buffer.
     */
    public async ganttLocal(args?: {unit?: 'ms' | 's', minWidth?: number, minHeight?: number, includeSteps?: RegExp | string[] }): Promise<Buffer> {
        const { unit, minWidth, minHeight, includeSteps } = {
            ...{ unit: 'ms', minWidth: 500, minHeight: 300 },
            ...(args ?? {}),
        };
        const substeps = includeSteps ? this.outputFlattened().filter((step) => {
            if (includeSteps instanceof RegExp) {
                return includeSteps.test(step.key);
            } else if (Array.isArray(includeSteps)) {
                return includeSteps.includes(step.key);
            }
            return true;
        }) : this.outputFlattened();

        const maxEndTs = Math.max(...substeps.map((step) => step.time.endTs));

        const chartData: ChartConfiguration = {
            type: 'bar',  // ChartJS uses 'bar' for both vertical and horizontal bar charts
            plugins: [
                {
                  id: 'customCanvasBackgroundColor',
                  beforeDraw: (chart, args, options) => {
                    const { ctx } = chart;
                    ctx.save();
                    ctx.globalCompositeOperation = 'destination-over';
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, chart.width, chart.height);
                    ctx.restore();
                  },
                },
              ],
            data: {
                labels: substeps.map((step) => `${step.key} - ${(step.time.endTs - step.time.startTs) / (unit === 'ms' ? 1 : 1000)}${unit}`),
                datasets: [
                    {
                        label: 'offset',
                        data: substeps.map((step) => (step.time.startTs - this.time.startTs) / (unit === 'ms' ? 1 : 1000)),
                        backgroundColor: 'white',
                    },
                    {
                        label: 'data',
                        data: substeps.map((step) => (step.time.endTs - step.time.startTs) / (unit === 'ms' ? 1 : 1000)),
                        backgroundColor: '#23395d',
                    },
                ],
            },
            options: {
                indexAxis: 'y',  // This makes the bar chart horizontal
                plugins: {
                    legend: {
                        display: false,
                    },
                },
                scales: {
                    x: {
                        position: 'top',
                        min: 0,
                        max: (maxEndTs - this.time.startTs) / (unit === 'ms' ? 1 : 1000),
                        stacked: true,
                        ticks: {
                            color: '#333333',
                        }
                    },
                    y: {
                        beginAtZero: true,
                        stacked: true,
                        ticks: {
                            color: '#333333',
                        }
                    },
                },
                layout: {
                    padding: {
                        left: 10,
                        right: 10,
                        top: 10,
                        bottom: 10,
                    },
                },
            }
        }

        // Create a canvas and render the chart
        const chartJSNodeCanvas = new ChartJSNodeCanvas({ width: Math.max(minWidth, substeps.length * 25), height: Math.max(minHeight, substeps.length * 25) });
        const image = await chartJSNodeCanvas.renderToBuffer(chartData);
        return image;
    }
}
