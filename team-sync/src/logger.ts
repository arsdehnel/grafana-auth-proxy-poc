import winston from 'winston'

const isDev = process.env.NODE_ENV !== 'production'

const devFormat = winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, task, ...rest }) => {
        const tag = task ? `[${task}] ` : ''
        const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''
        return `${timestamp} ${level}: ${tag}${message}${extra}`
    })
)

const prodFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
)

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    format: isDev ? devFormat : prodFormat,
    transports: [new winston.transports.Console()],
})

export default logger