/*
* == BSD2 LICENSE ==
* Copyright (c) 2019, Tidepool Project
*
* This program is free software; you can redistribute it and/or modify it under
* the terms of the associated License, which is identical to the BSD 2-Clause
* License as published by the Open Source Initiative at opensource.org.
*
* This program is distributed in the hope that it will be useful, but WITHOUT
* ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
* FOR A PARTICULAR PURPOSE. See the License for more details.
*
* You should have received a copy of the License along with this program; if
* not, you can obtain one from Tidepool Project at tidepool.org.
* == BSD2 LICENSE ==
*/

/* global navigator, BluetoothUUID */
/* eslint-disable global-require, no-global-assign */

import sundial from 'sundial';
import bows from 'bows';

const isBrowser = typeof window !== 'undefined';
const debug = isBrowser ? bows('ble-glucose') : console.log;

const options = {
  filters: [{
    services: ['glucose'],
  }],
  optionalServices: [
    'device_information',
    0xFFF0, // i-SENS v1.4 custom service
    'c4dea010-5a9d-11e9-8647-d663bd873d93', // i-SENS v1.5 custom service
    '00001523-1212-efde-1523-785feabcd123', // Nordic LED button service
  ],
};

const FLAGS = {
  TIME_OFFSET_PRESENT: { value: 0x01, name: 'Time offset present' },
  GLUCOSE_PRESENT: { value: 0x02, name: 'Glucose concentration, type and sample location present' },
  IS_MMOL: { value: 0x04, name: 'Glucose concentration units' },
  STATUS_PRESENT: { value: 0x08, name: 'Sensor status annunciation present' },
  CONTEXT_INFO: { value: 0x10, name: 'Context information follows' },
};

const CONTEXT_FLAGS = {
  CARBS: { value: 0x01, name: 'Carbohydrate ID and Carbohydrate present' },
  MEAL: { value: 0x02, name: 'Meal present' },
  TESTER_HEALTH: { value: 0x04, name: 'Tester-Health present' },
  EXERCISE: { value: 0x08, name: 'Exercise Duration and Exercise Intensity present' },
  MEDICATION: { value: 0x10, name: 'Medication ID and Medication present' },
  UNITS: { value: 0x20, name: 'Medication value units' },
  HBA1C: { value: 0x40, name: 'HbA1c present' },
  EXTENDED: { value: 0x80, name: 'Extended flags present' },
};

let self = null;

export default class bluetoothLE extends EventTarget {
  constructor() {
    super();
    this.records = [];
    this.contextRecords = [];
    self = this; // so that we can access it from event handler
  }

  static timeout(delay) {
    return new Promise((resolve, reject) => setTimeout(reject, delay, new Error('Timeout error')));
  }

  async scan() {
    debug('Requesting Bluetooth Device...');
    debug(`with  ${JSON.stringify(options)}`);

    if (typeof navigator !== 'undefined') {
      this.device = await Promise.race([
        bluetoothLE.timeout(15000),
        navigator.bluetooth.requestDevice(options),
      ]);

      debug(`Name: ${this.device.name}`);
      debug(`Id: ${this.device.id}`);
      debug(`Connected: ${this.device.gatt.connected}`);
    } else {
      throw new Error('navigator not available.');
    }
  }

  async connectTimeout(timeout = 40000) {
    await Promise.race([
      this.connect(),
      bluetoothLE.timeout(timeout),
    ]).catch((err) => {
      debug('Error:', err);
      throw err;
    });
  }

  async connect() {
    try {
      this.server = await this.device.gatt.connect();
      debug('Connected.');

      this.deviceInfoService = await this.server.getPrimaryService('device_information');
      this.glucoseService = await this.server.getPrimaryService('glucose');
      debug('Retrieved services.');

      const glucoseFeature = await this.glucoseService.getCharacteristic('glucose_feature');
      const features = await glucoseFeature.readValue();
      debug('Glucose features:', features.getUint16().toString(2).padStart(16, '0'));

      this.glucoseMeasurement = await this.glucoseService.getCharacteristic('glucose_measurement');
      await this.glucoseMeasurement.startNotifications();
      try {
        this.glucoseMeasurementContext = await this.glucoseService.getCharacteristic('glucose_measurement_context');
        await this.glucoseMeasurementContext.startNotifications();
        this.glucoseMeasurementContext.addEventListener('characteristicvaluechanged', bluetoothLE.handleContextNotifications);
      } catch (err) {
        debug(err);
      }
      this.racp = await this.glucoseService.getCharacteristic('record_access_control_point');
      await this.racp.startNotifications();
      debug('Notifications started.');

      this.glucoseMeasurement.addEventListener('characteristicvaluechanged', this.handleNotifications);
      this.racp.addEventListener('characteristicvaluechanged', this.handleRACP);
      debug('Event listeners added.');
    } catch (error) {
      debug(`Argh! ${error}`);
      throw error;
    }
  }

  async disconnect() {
    if (!this.device) {
      return;
    }
    debug('Stopping notifications and removing event listeners...');
    try {
      this.glucoseMeasurement.removeEventListener(
        'characteristicvaluechanged',
        this.handleNotifications,
      );
      await this.glucoseMeasurement.stopNotifications();
      this.glucoseMeasurement = null;
    } catch (err) {
      debug('Could not stop glucose measurement');
    }
    try {
      this.glucoseMeasurementContext.removeEventListener(
        'characteristicvaluechanged',
        this.handleContextNotifications,
      );
      await this.glucoseMeasurementContext.stopNotifications();
      this.glucoseMeasurementContext = null;
    } catch (err) {
      debug('Could not stop glucose measurement context');
    }
    try {
      this.racp.removeEventListener(
        'characteristicvaluechanged',
        this.handleRACP,
      );
      debug('Removed RACP listener');
      await this.racp.stopNotifications();
      this.racp = null;
    } catch (err) {
      debug('Could not stop RACP');
    }
    debug('Disconnecting from Bluetooth Device...');
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    } else {
      debug('Bluetooth Device is already disconnected');
    }
  }

  async getDeviceInfo() {
    debug('Getting Device Information Characteristics...');
    const characteristics = await this.deviceInfoService.getCharacteristics();
    self.deviceInfo = {};

    const decoder = new TextDecoder('utf-8');

    /* eslint-disable no-await-in-loop */
    for (let i = 0; i < characteristics.length; i += 1) {
      switch (characteristics[i].uuid) {
        case BluetoothUUID.getCharacteristic('manufacturer_name_string'):
          self.deviceInfo.manufacturers = [decoder.decode(await characteristics[i].readValue())];
          break;

        case BluetoothUUID.getCharacteristic('model_number_string'):
          self.deviceInfo.model = decoder.decode(await characteristics[i].readValue());
          break;

        default:
          break;
      }
    }
    /* eslint-enable no-await-in-loop */

    return self.deviceInfo;
  }

  async sendCommand(cmd) {
    await this.racp.writeValueWithResponse(new Uint8Array(cmd));
    debug('Sent command.');
  }

  async getNumberOfRecords() { await this.sendCommand([0x04, 0x01]); }
    
  async getDeltaNumberOfRecords(seqNum) {
    const buffer = new ArrayBuffer(5);
    const view = new DataView(buffer);
    
    view.setUint8(0, 0x04); // op code: report number of stored records
    view.setUint8(1, 0x03); // operator: greater than or equal to
    view.setUint8(2, 0x01); // operand: filter type - sequence number
    view.setUint16(3, seqNum, true); // operand: sequence number
    await this.sendCommand(buffer); 
  }

  async getAllRecords() {
    self.records = [];
    self.contextRecords = [];
    await this.sendCommand([0x01, 0x01]);
  }

  async getDeltaRecords(seqNum) {
    const buffer = new ArrayBuffer(5);
    const view = new DataView(buffer);
    
    view.setUint8(0, 0x01); // op code: report stored records
    view.setUint8(1, 0x03); // operator: greater than or equal to
    view.setUint8(2, 0x01); // operand: filter type - sequence number
    view.setUint16(3, seqNum, true); // operand: sequence number
    self.records = [];
    self.contextRecords = [];
    await this.sendCommand(buffer);
  }

  static handleContextNotifications(event) {
    const { value } = event.target;
    debug('Received context:', bluetoothLE.buf2hex(value.buffer));
    this.parsed = bluetoothLE.parseMeasurementContext(value);
    self.contextRecords.push(this.parsed);
  }

  handleNotifications(event) {
    const { value } = event.target;

    debug('Received:', bluetoothLE.buf2hex(value.buffer));
    this.parsed = bluetoothLE.parseGlucoseMeasurement(value);
    if (this.parsed.seqNum !== self.records[self.records.length-1]?.seqNum) {
        self.records.push(this.parsed);
    } else {
        debug('Skipping double entry..');
    }
  }

  handleRACP(event) {
    const { value } = event.target;
    this.racpObject = {
      opCode: value.getUint8(0),
      operator: value.getUint8(1),
      operand: value.getUint16(2, true),
    };
    debug('RACP Event:', this.racpObject);

    switch (this.racpObject.opCode) {
      case 0x05:
        self.dispatchEvent(new CustomEvent('numberOfRecords', {
          detail: this.racpObject.operand,
        })); 
        break;
      case 0x06:
        if (this.racpObject.operand === 0x0101) {
          debug('Success.');
          self.dispatchEvent(new CustomEvent('data', {
            detail: {
              records: self.records,
              contextRecords: self.contextRecords,
            },
          }));
        } else if (this.racpObject.operand === 0x0601) {
          // no records found
          self.dispatchEvent(new CustomEvent('data', {
            detail: [],
          }));
        }
        break;
      default:
        throw Error('Unrecognized op code');
    }
  }

  static parseMeasurementContext(result) {
    const record = {
      flags: result.getUint8(0),
      seqNum: result.getUint16(1, true),
    };
    let offset = 3;

    if (this.hasFlag(CONTEXT_FLAGS.EXTENDED, record.flags)) {
      record.extended = result.getUint8(offset);
      offset += 1;
    }

    if (this.hasFlag(CONTEXT_FLAGS.CARBS, record.flags)) {
      record.carbID = result.getUint8(offset);
      record.carbUnits = result.getUint16(offset + 1, true);
      offset += 2;
    }

    if (this.hasFlag(CONTEXT_FLAGS.MEAL, record.flags)) {
      record.meal = result.getUint8(offset);
      offset += 1;
    }

    return record;
  }

  static parseGlucoseMeasurement(result) {
    const record = {
      flags: result.getUint8(0),
      seqNum: result.getUint16(1, true),
    };
    let offset = 0;

    const dateTime = {
      year: result.getUint16(3, true),
      month: result.getUint8(5),
      day: result.getUint8(6),
      hours: result.getUint8(7),
      minutes: result.getUint8(8),
      seconds: result.getUint8(9),
    };

    if (dateTime.month === 13) {
      // handle i-SENS firmware bug, where the month for base time
      // is calculated incorrectly when they subtract time offset
      dateTime.month = 1;
    }


    if (this.hasFlag(FLAGS.TIME_OFFSET_PRESENT, record.flags)) {
      record.payload = {
        internalTime: sundial.buildTimestamp(dateTime),
        timeOffset: result.getInt16(10, true),
      };
      offset += 2;
    }
    
    record.timestamp = sundial.buildTimestamp(dateTime);

    if (this.hasFlag(FLAGS.GLUCOSE_PRESENT, record.flags)) {
      if (this.hasFlag(FLAGS.IS_MMOL, record.flags)) {
        record.units = 'mmol/L';
      } else {
        record.units = 'mg/dL';
      }
      record.value = this.getSFLOAT(result.getUint16(offset + 10, true), record.units);
      record.type = result.getUint8(offset + 12) >> 4;
      record.location = result.getUint8(offset + 12) && 0x0F;

      if (this.hasFlag(FLAGS.STATUS_PRESENT, record.flags)) {
        record.status = result.getUint16(offset + 13, true);
      }
    } else {
      debug('No glucose value present for ', sundial.formatDeviceTime(record.timestamp));
    }

    record.hasContext = this.hasFlag(FLAGS.CONTEXT_INFO, record.flags);

    return record;
  }

  static getSFLOAT(value, units) {
    switch (value) {
      case 0x07FF:
        return NaN;
      case 0x0800:
        return NaN;
      case 0x07FE:
        return Number.POSITIVE_INFINITY;
      case 0x0802:
        return Number.NEGATIVE_INFINITY;
      case 0x0801:
        return NaN;
      default:
        break;
    }

    let exponent = value >> 12;
    let mantissa = value & 0x0FFF;

    if (exponent >= 0x0008) {
      exponent = -((0x000F + 1) - exponent);
    }

    if (units === 'mg/dL') {
      exponent += 5; // convert kg/L to mg/dL
    } else if (units === 'mmol/L') {
      exponent += 3; // convert mol/L to mmol/L
    } else {
      throw Error('Illegal units for glucose value');
    }

    if (mantissa >= 0x0800) {
      mantissa = -((0x0FFF + 1) - mantissa);
    }

    return mantissa * (10 ** exponent);
  }

  static hasFlag(flag, v) {
    if (flag.value & v) {
      return true;
    }
    return false;
  }

  static buf2hex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
  }
}
