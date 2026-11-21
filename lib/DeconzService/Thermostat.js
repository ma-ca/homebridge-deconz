// homebridge-deconz/lib/DeconzService/Thermostat.js
// Copyright © 2022-2026 Erik Baauw. All rights reserved.
//
// Homebridge plugin for deCONZ.

import { timeout } from 'homebridge-lib'

import { DeconzService } from '../DeconzService/index.js'
import '../DeconzService/SensorsResource.js'

// Pause (in ms) between the requests that write the schedule to deCONZ
const scheduleRequestDelay = 2000

// Eve lists the week from Monday to Sunday.  deCONZ uses an ISO weekday
// bitmap for the "W<bitmap>" keys of config.schedule: Mon = bit 6 .. Sun = bit 0.
const eveDayBits = [0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01]
const eveDayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Eve ProgramData 0xFA: per day 8 bytes, up to 4 periods of start/end time,
// in 10 minute units; 0xFF for unused.
const eveUnused = 0xFF
const eveMaxTime = 143 // 23:50

function toEveTime (minutes) {
  return Math.min(eveMaxTime, Math.round(minutes / 10))
}

function fromEveTime (value) {
  const minutes = Math.min(value * 10, 23 * 60 + 59)
  return 'T' + String(Math.floor(minutes / 60)).padStart(2, '0') +
    ':' + String(minutes % 60).padStart(2, '0')
}

/** Convert deCONZ config.schedule to Eve's 7 days of 8 bytes.
  * Eve only knows on/off periods with one comfort and one eco temperature.
  * So eco is taken as the lowest setpoint and comfort as the highest one.
  * @param {?Object} schedule - The config.schedule from deCONZ, e.g.
  * `{ W62: [{ localtime: 'T05:00', heatsetpoint: 2200 }, ...] }`.
  * @returns {{ days: Buffer, eco: ?number, comfort: ?number }}
  */
function scheduleToEve (schedule) {
  const days = Buffer.alloc(7 * 8, eveUnused)
  const transitionsByDay = eveDayBits.map(() => [])
  let eco
  let comfort
  for (const key in schedule) {
    const bitmap = parseInt(key.slice(1), 10)
    if (!Array.isArray(schedule[key])) {
      continue
    }
    for (const t of schedule[key]) {
      const match = /^T(\d\d):(\d\d)$/.exec(t.localtime)
      if (match == null || typeof t.heatsetpoint !== 'number') {
        continue
      }
      eco = eco == null ? t.heatsetpoint : Math.min(eco, t.heatsetpoint)
      comfort = comfort == null ? t.heatsetpoint : Math.max(comfort, t.heatsetpoint)
      for (let d = 0; d < 7; d++) {
        if (bitmap & eveDayBits[d]) {
          transitionsByDay[d].push({
            minutes: 60 * Number(match[1]) + Number(match[2]),
            heatsetpoint: t.heatsetpoint
          })
        }
      }
    }
  }
  const isComfort = heatsetpoint => comfort > eco && heatsetpoint >= (eco + comfort) / 2
  for (let d = 0; d < 7; d++) {
    let n = d * 8
    let start
    const transitions = transitionsByDay[d].sort((a, b) => a.minutes - b.minutes)
    for (const t of transitions) {
      if (isComfort(t.heatsetpoint)) {
        if (start == null) {
          start = t.minutes
        }
      } else if (start != null) {
        if (n < d * 8 + 8) {
          days[n++] = toEveTime(start)
          days[n++] = toEveTime(t.minutes)
        }
        start = null
      }
    }
    if (start != null && n < d * 8 + 8) {
      days[n++] = toEveTime(start)
      days[n++] = eveMaxTime
    }
  }
  return { days, eco, comfort }
}

/**
  * @memberof DeconzService
  */
class Thermostat extends DeconzService.SensorsResource {
  constructor (accessory, resource, params = {}) {
    params.Service = accessory.Services.hap.Thermostat
    super(accessory, resource, params)

    this.addCharacteristicDelegate({
      key: 'currentTemperature',
      Characteristic: this.Characteristics.hap.CurrentTemperature,
      unit: '°C',
      props: { minValue: -40, maxValue: 100, minStep: 0.1 },
      value: 0
    })

    this.addCharacteristicDelegate({
      key: 'targetTemperature',
      Characteristic: this.Characteristics.hap.TargetTemperature,
      unit: '°C',
      props: { minValue: 5, maxValue: 30, minStep: 0.5 },
      value: 0
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        await this.put('/config', { heatsetpoint: Math.round(value * 100) })
      }
    })

    if (resource.body.state.valve !== undefined) {
      this.addCharacteristicDelegate({
        key: 'valvePosition',
        Characteristic: this.Characteristics.eve.ValvePosition,
        unit: '%'
      })
    }

    this.addCharacteristicDelegate({
      key: 'currentState',
      Characteristic: this.Characteristics.hap.CurrentHeatingCoolingState,
      props: {
        validValues: [
          this.Characteristics.hap.CurrentHeatingCoolingState.OFF,
          this.Characteristics.hap.CurrentHeatingCoolingState.HEAT
        ]
      }
    })

    this.addCharacteristicDelegate({
      key: 'targetState',
      Characteristic: this.Characteristics.hap.TargetHeatingCoolingState,
      props: {
        validValues: [
          this.Characteristics.hap.TargetHeatingCoolingState.OFF,
          this.Characteristics.hap.TargetHeatingCoolingState.HEAT
        ]
      }
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        await this.put('/config', {
          mode: value === this.Characteristics.hap.TargetHeatingCoolingState.OFF
            ? 'off'
            : this.capabilities.heatValue
        })
      }
    })

    this.addCharacteristicDelegate({
      key: 'offset',
      Characteristic: this.Characteristics.my.Offset,
      unit: '°C',
      props: { minValue: -5, maxValue: 5, minStep: 0.1 },
      value: 0
    }).on('didSet', async (value, fromHomeKit) => {
      if (fromHomeKit) {
        await this.put('/config', { offset: Math.round(value * 100) })
      }
    })

    this.addCharacteristicDelegate({
      key: 'displayUnits',
      Characteristic: this.Characteristics.hap.TemperatureDisplayUnits,
      value: this.Characteristics.hap.TemperatureDisplayUnits.CELSIUS
    })

    this.addCharacteristicDelegate({
      key: 'programData',
      Characteristic: this.Characteristics.eve.ProgramData,
      silent: true,
      value: Buffer.from('ff04f6', 'hex').toString('base64')
    })

    this.addCharacteristicDelegate({
      key: 'programCommand',
      Characteristic: this.Characteristics.eve.ProgramCommand,
      silent: true
    }).on('didSet', async (value, fromHomeKit) => {
      if (!fromHomeKit) {
        return
      }
      const buffer = Buffer.from(value, 'base64')
      this.debug('program command: %s', buffer.toString('hex'))
      let scheduleOn
      let offset
      let temperatures // 3 bytes in 0.5°C, as sent by Eve
      let eveDays // Buffer with 7 days of 8 bytes
      for (let i = 0; i < buffer.length; i++) {
        const opcode = buffer[i]
        switch (opcode) {
          case 0x00: // Begin
          case 0x06: // End
            break
          case 0xFF: // Reset?
            i += 2
            break
          case 0x12: // Temperature offset
            offset = buffer.readInt8(++i) / 10
            break
          case 0x13: // Schedule enable
            scheduleOn = buffer[++i] === 1
            break
          // Skip the payload of the opcodes below, so its bytes aren't
          // mistaken for opcodes.
          case 0x14: // Install status
            i += 1
            break
          case 0x19: // Vacation
            i += 2
            break
          case 0xF6: // Open window
            i += 3
            break
          case 0xF4: // Temperatures: Eve writes 3 bytes in 0.5°C, e.g. 2a 22 2a
            if (i + 3 < buffer.length) {
              temperatures = [buffer[i + 1], buffer[i + 2], buffer[i + 3]]
            }
            i += 3
            break
          case 0xFC: // Time: minute, hour, day, month, year
            i += 5
            break
          case 0xFA: // Weekly schedule: 7 days of 8 bytes
            if (i + 56 < buffer.length) {
              eveDays = buffer.subarray(i + 1, i + 57)
            }
            i += 56
            break
          case 0x1A: // Free day: 8 bytes
            i += 8
            break
          default: // Unknown — skip
            break
        }
      }
      // Eve sends the schedule together with schedule_on.  Handle one command
      // at a time, since writing the schedule takes a while, and write the
      // schedule before enabling it.
      const previous = this._programQueue ?? Promise.resolve()
      this._programQueue = previous.then(async () => {
        let written = false
        if (eveDays != null) {
          try {
            written = await this._writeSchedule(eveDays, temperatures)
          } catch (error) {
            this.warn(error)
          }
        }
        if (scheduleOn != null) {
          if (written) {
            await timeout(scheduleRequestDelay)
          }
          this.log('schedule_on: set to %s', scheduleOn)
          await this.put('/config', { schedule_on: scheduleOn })
          this.values.programData = this._buildProgramData()
        }
        if (offset != null) {
          await this.put('/config', { offset: Math.round(offset * 100) })
          this.values.programData = this._buildProgramData()
        }
      }).catch(error => { this.warn(error) })
      await this._programQueue
    })

    if (resource.body.config.displayflipped !== undefined) {
      this.addCharacteristicDelegate({
        key: 'imageMirroring',
        Characteristic: this.Characteristics.hap.ImageMirroring
      }).on('didSet', async (value, fromHomeKit) => {
        if (fromHomeKit) {
          await this.put('/config', { displayflipped: value })
        }
      })
    }
    if (resource.body.config.externalsensortemp !== undefined) {
      this.addCharacteristicDelegate({
        key: 'useExternalTemperature',
        value: false,
        silent: true
      })
    }

    if (resource.body.config.locked !== undefined) {
      this.addCharacteristicDelegate({
        key: 'lockPhysicalControls',
        Characteristic: this.Characteristics.hap.LockPhysicalControls
      }).on('didSet', async (value, fromHomeKit) => {
        if (fromHomeKit) {
          await this.put('/config', {
            locked: value === this.Characteristics.hap.LockPhysicalControls
              .CONTROL_LOCK_ENABLED
          })
        }
      })
    }

    super.addCharacteristicDelegates()

    this.update(resource.body, resource.rpath)
  }

  updateState (state) {
    if (state.on != null) {
      this.values.currentState = state.on
        ? this.Characteristics.hap.CurrentHeatingCoolingState.HEAT
        : this.Characteristics.hap.CurrentHeatingCoolingState.OFF
    }
    if (!this.values.useExternalTemperature && state.temperature != null) {
      this.values.currentTemperature = Math.round(state.temperature / 10) / 10
    }
    if (state.valve != null) {
      this.values.valvePosition = state.valve
    }
    super.updateState(state)
  }

  _buildProgramData () {
    const buf = Buffer.alloc(128)
    let o = 0
    // 0x12 — temperature offset in 0.5°C steps
    buf[o++] = 0x12
    buf[o++] = Math.round((this.values.offset ?? 0) * 2)
    // 0x13 — schedule_on flag
    buf[o++] = 0x13
    buf[o++] = this._scheduleOn ? 0x01 : 0x00
    this._sentToEve = null
    if (this._schedule != null) {
      // 0xF4 — temperatures, in 0.5°C.  Eve writes 3 bytes (2a 22 2a), but the
      // old homebridge-hue code sent 4 on read.  With 3 bytes (followed by 0xFA)
      // Eve showed an empty schedule.
      // [current, target, eco, comfort]
      // 0xFA — weekly schedule, Monday to Sunday
      try {
        const { days, eco, comfort } = scheduleToEve(this._schedule)
        const toEveTemp = v => Math.round(v / 50)
        if (eco != null && comfort != null) {
          buf[o++] = 0xF4
          buf[o++] = toEveTemp(this.values.currentTemperature * 100)
          buf[o++] = toEveTemp(this.values.targetTemperature * 100)
          buf[o++] = toEveTemp(eco)
          buf[o++] = toEveTemp(comfort)
          buf[o++] = 0xFA
          o += days.copy(buf, o)
          // Remember what Eve was shown, to recognise a save that didn't
          // change the schedule.
          this._sentToEve = { days, eco: toEveTemp(eco), comfort: toEveTemp(comfort) }
        }
      } catch (error) {
        this.warn(error)
      }
    }
    this.debug('program data: %s', buf.subarray(0, o).toString('hex'))
    return buf.subarray(0, o).toString('base64')
  }

  // Write the schedule that Eve sent to deCONZ: one POST for each distinct set
  // of transitions (for the weekdays that share it), and one DELETE for the
  // weekdays without comfort periods.  The requests are sent one at a time.
  // Returns true when at least one request was sent.
  async _writeSchedule (eveDays, temperatures) {
    if (this._schedule == null) {
      this.warn('schedule: not supported by deCONZ, not written')
      return false
    }
    if (temperatures == null) {
      this.warn('schedule: no temperatures received, not written')
      return false
    }
    // Eve's 3 bytes, in 0.5°C, are [?, eco, comfort]; the first one is unknown.
    const eco = temperatures[1] * 50
    const comfort = temperatures[2] * 50
    // deCONZ accepts 5°C to 30°C.  Check up front, so a rejected POST doesn't
    // leave a partial schedule (the DELETE would have succeeded).
    if (eco < 500 || eco > 3000 || comfort < 500 || comfort > 3000) {
      this.warn('schedule: eco %s or comfort %s out of range, not written', eco, comfort)
      return false
    }
    // Eve's model is lossy, and deCONZ might not have read the full week yet.
    // Don't replace the deCONZ schedule by a flattened or incomplete copy when
    // Eve just sends back what it was shown.
    const fresh = scheduleToEve(this._schedule)
    const generated = fresh.eco == null
      ? null
      : {
          days: fresh.days,
          eco: Math.round(fresh.eco / 50),
          comfort: Math.round(fresh.comfort / 50)
        }
    for (const shown of [this._sentToEve, generated]) {
      if (
        shown != null && shown.days.equals(eveDays) &&
        shown.eco === temperatures[1] && shown.comfort === temperatures[2]
      ) {
        this.debug('schedule: unchanged, not written')
        return false
      }
    }
    const groups = {} // transitions (json) → ISO weekday bitmap
    let empty = 0
    for (let d = 0; d < 7; d++) {
      const transitions = []
      const periods = []
      for (let j = 0; j < 8; j += 2) {
        const start = eveDays[d * 8 + j]
        const end = eveDays[d * 8 + j + 1]
        if (start === eveUnused || end === eveUnused) {
          continue
        }
        periods.push(fromEveTime(start) + '-' + fromEveTime(end))
        transitions.push({ localtime: fromEveTime(start), heatsetpoint: comfort })
        if (end < eveMaxTime) {
          transitions.push({ localtime: fromEveTime(end), heatsetpoint: eco })
        }
      }
      this.debug('schedule: %s: %s', eveDayNames[d], periods.join(' ') || '-')
      if (transitions.length === 0) {
        empty |= eveDayBits[d]
      } else {
        const key = JSON.stringify(transitions)
        groups[key] = (groups[key] ?? 0) | eveDayBits[d]
      }
    }
    const requests = []
    for (const key in groups) {
      requests.push({ bitmap: groups[key], transitions: JSON.parse(key) })
    }
    if (empty !== 0) {
      requests.push({ bitmap: empty })
    }
    for (let i = 0; i < requests.length; i++) {
      if (i > 0) {
        await timeout(scheduleRequestDelay)
      }
      const { bitmap, transitions } = requests[i]
      const path = '/config/schedule/W' + bitmap
      let ok
      if (transitions == null) {
        this.log('schedule: DELETE %s', path)
        ok = await this.delete(path)
      } else {
        this.log('schedule: POST %s %j', path, transitions)
        ok = await this.post(path, transitions)
      }
      if (!ok) {
        this.warn('schedule: request failed, not writing the rest')
        return true
      }
    }
    return requests.length > 0
  }

  updateConfig (config) {
    if (config.displayflipped != null) {
      this.values.imageMirroring = config.displayflipped
    }
    if (this.values.useExternalTemperature && config.externalsensortemp != null) {
      this.values.currentTemperature = Math.round(config.externalsensortemp / 10) / 10
    }
    if (config.heatsetpoint != null) {
      this.values.targetTemperature = Math.round(config.heatsetpoint / 50) / 2
    }
    if (config.locked != null) {
      this.values.lockPhysicalControls = config.locked
        ? this.Characteristics.hap.LockPhysicalControls.CONTROL_LOCK_ENABLED
        : this.Characteristics.hap.LockPhysicalControls.CONTROL_LOCK_DISABLED
    }
    if (config.mode != null) {
      this.values.targetState = config.mode === 'off'
        ? this.Characteristics.hap.TargetHeatingCoolingState.OFF
        : this.Characteristics.hap.TargetHeatingCoolingState.HEAT
    }
    if (config.offset != null) {
      this.values.offset = Math.round(config.offset / 10) / 10
    }
    if (config.schedule_on != null) {
      this._scheduleOn = config.schedule_on
    }
    if (config.schedule != null && typeof config.schedule === 'object') {
      this._schedule = config.schedule
    }
    if (
      config.schedule_on != null || config.offset != null ||
      config.schedule != null || config.heatsetpoint != null
    ) {
      this.values.programData = this._buildProgramData()
    }
    super.updateConfig(config)
  }
}

DeconzService.Thermostat = Thermostat
