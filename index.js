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

const EventEmitter = require('events');
const sundial = require('sundial');

const options = {
  filters: [{
    services: ['glucose'],
  }],
  optionalServices: ['device_information'],
};

const FLAGS = {
  TIME_OFFSET_PRESENT: { value: 0x01, name: 'Time offset present' },
  GLUCOSE_PRESENT: { value: 0x02, name: 'Glucose concentration, type and sample location present' },
  IS_MMOL: { value: 0x04, name: 'Glucose concentration units' },
  STATUS_PRESENT: { value: 0x08, name: 'Sensor status annunciation present' },
  CONTEXT_INFO: { value: 0x10, name: 'Context information follows' },
};

let self = null;

class bluetoothLE extends EventEmitter {
  constructor() {
    super();
    this.records = [];
    self = this; // so that we can access it from event handler
  }

  static timeout(delay) {
    return new Promise((resolve, reject) => setTimeout(reject, delay, new Error('Timeout error')));
  }

  async scan() {
    console.log('Requesting Bluetooth Device...');
    console.log(`with  ${JSON.stringify(options)}`);

    if (typeof navigator !== 'undefined') {
      this.device = await Promise.race([
        bluetoothLE.timeout(15000),
        navigator.bluetooth.requestDevice(options),
      ]);

      console.log(`Name: ${this.device.name}`);
      console.log(`Id: ${this.device.id}`);
      console.log(`Connected: ${this.device.gatt.connected}`);
    } else {
      throw new Error('navigator not available.');
    }
  }

  async connectTimeout(timeout = 40000) {
    await Promise.race([
      this.connect(),
      bluetoothLE.timeout(timeout),
    ]).catch((err) => {
      console.log('Error:', err);
      throw err;
    });
  }

  async connect() {
    try {
      this.server = await this.device.gatt.connect();
      console.log('Connected.');

      this.deviceInfoService = await this.server.getPrimaryService('device_information');
      this.glucoseService = await this.server.getPrimaryService('glucose');
      console.log('Retrieved services.');

      const glucoseFeature = await this.glucoseService.getCharacteristic('glucose_feature');
      const features = await glucoseFeature.readValue();
      console.log('Glucose features:', features.getUint16().toString(2).padStart(16, '0'));

      this.glucoseMeasurement = await this.glucoseService.getCharacteristic('glucose_measurement');
      await this.glucoseMeasurement.startNotifications();
      this.glucoseMeasurementContext = await this.glucoseService.getCharacteristic('glucose_measurement_context');
      await this.glucoseMeasurementContext.startNotifications();
      this.racp = await this.glucoseService.getCharacteristic('record_access_control_point');
      await this.racp.startNotifications();
      console.log('Notifications started.');

      this.glucoseMeasurementContext.addEventListener('characteristicvaluechanged', bluetoothLE.handleContextNotifications);
      this.glucoseMeasurement.addEventListener('characteristicvaluechanged', this.handleNotifications);
      this.racp.addEventListener('characteristicvaluechanged', this.handleRACP);
      console.log('Event listeners added.');
    } catch (error) {
      console.log(`Argh! ${error}`);
      throw error;
    }
  }

  disconnect() {
    if (!this.device) {
      return;
    }
    console.log('Disconnecting from Bluetooth Device...');
    if (this.device.gatt.connected) {
      this.device.gatt.disconnect();
    } else {
      console.log('Bluetooth Device is already disconnected');
    }
  }

  async getDeviceInfo() {
    console.log('Getting Device Information Characteristics...');
    const characteristics = await this.deviceInfoService.getCharacteristics();
    self.deviceInfo = {};

    const decoder = new TextDecoder('utf-8');

    /* eslint-disable no-await-in-loop, requests to devices are sequential */
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
    await this.racp.writeValue(new Uint8Array(cmd));
    console.log('Sent command.');
  }

  async getNumberOfRecords() { await this.sendCommand([0x04, 0x01]); }

  async getAllRecords() {
    self.records = [];
    await this.sendCommand([0x01, 0x01]);
  }

  static handleContextNotifications(event) {
    const { value } = event.target;
    console.log('Received context:', bluetoothLE.buf2hex(value.buffer));
  }

  handleNotifications(event) {
    const { value } = event.target;

    console.log('Received:', bluetoothLE.buf2hex(value.buffer));
    this.parsed = bluetoothLE.parseGlucoseMeasurement(value);
    self.records.push(this.parsed);
  }

  handleRACP(event) {
    const { value } = event.target;
    this.racpObject = {
      opCode: value.getUint8(0),
      operator: value.getUint8(1),
      operand: value.getUint16(2, true),
    };
    console.log('RACP Event:', this.racpObject);

    switch (this.racpObject.opCode) {
      case 0x05:
        self.emit('numberOfRecords', this.racpObject.operand);
        break;
      case 0x06:
        if (this.racpObject.operand === 0x0101) {
          console.log('Success.');
          self.emit('data', self.records);
        }
        break;
      default:
        throw Error('Unrecognized op code');
    }
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

    if (this.hasFlag(FLAGS.TIME_OFFSET_PRESENT, record.flags)) {
      record.payload = {
        internalTime: sundial.buildTimestamp(dateTime),
        timeOffset: result.getInt16(10, true),
      };
      record.timestamp = sundial.applyOffset(
        record.payload.internalTime,
        record.payload.timeOffset,
      );
      offset += 2;
    } else {
      record.timestamp = sundial.buildTimestamp(dateTime);
    }

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
      console.log('No glucose value present for ', sundial.formatDeviceTime(record.timestamp));
    }

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
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
  }
}

module.exports = bluetoothLE;
