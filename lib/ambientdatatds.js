/**
 * Copyright reelyActive 2022-2023
 * We believe in an open Internet of Things
 */


const advlib = require('advlib');
const Barnowl = require('barnowl');
const Connection = require('tedious').Connection;
const Request = require('tedious').Request;
const config = { database: require('../config/database.js'),
                 barnowl: require('../config/barnowl.js') };

 
const TYPES = require('tedious').TYPES;
const PROCESSORS = [
    { processor: require('advlib-ble'),
      libraries: [ require('advlib-ble-services'),
                   require('advlib-ble-manufacturers') ],
      options: { ignoreProtocolOverhead: true } }
];
const DB_CONFIG = {
    server: config.database.sqlServer,
    authentication: {
        type: "default",
        options: {
            userName: config.database.sqlUsername,
            password: config.database.sqlPassword
        }
    },
    options: {
        encrypt: false,
        instanceName: config.database.sqlInstanceName,
        database: config.database.sqlDatabase
    }
};


/**
 * Ambient Data TDS Class
 * Collect and process wireless ambient data packets, writing specific
 * properties to SQL Server using TDS.
 */
class AmbientDataTDS {

  /**
   * AmbientDataTDS constructor
   * @param {Object} options The configuration options.
   * @constructor
   */
  constructor(options) {
    let self = this;
    options = options || {};

    this.isDebug = options.isDebug || false;
    this.isTdsRequestPending = false;
    this.tdsRequestStrings = [];
    this.connection = new Connection(DB_CONFIG);
    this.connection.on('connect', (err) => {
      if(err) {
        handleError(err, 'Database connection failed');
      }
      else {
        console.log('Database connection successful.');
      }
    });
    this.connection.connect();

    this.barnowl = createBarnowl(options);
    this.barnowl.on('raddec', (raddec) => {
        self.handleEvent('raddec', raddec);
    });
  }

  /**
   * Handle an event that may be written to the database.
   * @param {String} name The event name.
   * @param {Object} data The event data.
   */
  handleEvent(name, data) {
    let self = this;

    switch(name) {
      case 'raddec':
        let dynamb = processRaddec(data, self);
        return handleAmbientData(data, dynamb, self);
      case 'dynamb':
        return handleAmbientData(null, data, self);
    }
  }

}


/**
 * Create a barnowl instance with optional UDP listener.
 * @param {Object} options The configuration options.
 * @return {Barnowl} The Barnowl instance.
 */
function createBarnowl(options) {
  let barnowl = new Barnowl({
      enableMixing: config.barnowl.enableMixing,
      mixingDelayMilliseconds: config.barnowl.mixingDelayMilliseconds
  });

  if(config.barnowl.enableUDPListener) {
    barnowl.addListener(Barnowl, {}, Barnowl.UdpListener, {});
  }

  return barnowl;
}


/**
 * Process the given raddec's data packets, if any, into dynamb-compatible JSON.
 * @param {Raddec} raddec The radio decoding to process.
 * @param {AmbientDataTDS} instance The AmbientDataTDS instance.
 * @return {Object} The processed data as dynamb-compatible JSON.
 */
function processRaddec(raddec, instance) {
  let dynamb = {
      deviceId: raddec.transmitterId,
      deviceIdType: raddec.transmitterIdType,
      timestamp: raddec.timestamp
  };
  let processedPackets = {};

  try {
    processedPackets = advlib.process(raddec.packets, PROCESSORS);
  }
  catch(err) {
    if(instance.isDebug) {
      handleError(err, 'Packet processing in advlib failed');
    }
  }

  return Object.assign(processedPackets, dynamb);
}


/**
 * Handle the given ambient data, and write to the database as required.
 * @param {Raddec} raddec The radio decoding to handle.
 * @param {Object} dynamb The dynamb(-like) object to handle.
 * @param {AmbientDataTDS} instance The AmbientDataTDS instance.
 * @return {Object} The processed data as dynamb-compatible JSON.
 */
function handleAmbientData(raddec, dynamb, instance) {
  // TODO: user-configurable required properties
  let isTemperatureSensor = (dynamb &&
                             dynamb.hasOwnProperty('temperature') &&
                             dynamb.hasOwnProperty('txCount'));

  if(isTemperatureSensor) {
    let row = createRow(raddec, dynamb);

    if(instance.isDebug) { console.log(row); }

    insertRow(row, instance);
  }
  else if(instance.isDebug) {
    console.log('Non-temperature sensor', dynamb.deviceId, 'decoded.');
  }
}


/**
 * Create the table row as JSON.
 * @param {Raddec} raddec The radio decoding data.
 * @param {Object} dynamb The dynamb(-like) data.
 * @return {Object} The table row as JSON.
 */
function createRow(raddec, dynamb) {
  let id = raddec.signature + '-' + raddec.timestamp;
  let isoTimestamp = new Date(raddec.timestamp).toISOString();
  let timestamp = isoTimestamp.substring(0, 23).replace('T', ' ');
  let rssi = raddec.rssiSignature[0].rssi;

  return {
      id: id,
      deviceSignature: raddec.signature,
      timestamp: timestamp,
      temperature: Number.parseFloat(dynamb.temperature.toFixed(4)),
      txCount: dynamb.txCount,
      batteryPercentage: dynamb.batteryPercentage || 100,
      strongestReceiverSignature: raddec.receiverSignature,
      rssi: rssi
  };
}


/**
 * Insert a row with the given data.
 * @param {Object} row The row data to insert.
 * @param {AmbientDataTDS} instance The AmbientDataTDS instance.
 */
function insertRow(row, instance) {
  let values = "('" + row.id + "'" +
               ", '" + row.deviceSignature + "'" +
               ", '" + row.timestamp + "'" +
               ", '" + row.temperature + "'" +
               ", '" + row.txCount + "'" +
               ", '" + row.batteryPercentage + "'" +
               ", '" + row.strongestReceiverSignature + "'" +
               ", '" + row.rssi + "')";
  let requestString = "INSERT INTO " + instance.tableName + " VALUES " +
                      values + ";";

  instance.tdsRequestStrings.push(requestString);

  if(!instance.isTdsRequestPending) {
    tdsRequest(instance);
  }
  else if(instance.isDebug) {
    console.log('Database insert queued: ' + instance.tdsRequestStrings.length +
                ' requests pending.');
  }
}


/**
 * Execute the next request in the queue and self-iterate, if required.
 * @param {AmbientDataTDS} instance The AmbientDataTDS instance.
 */
function tdsRequest(instance) {
  let requestString = instance.tdsRequestStrings.shift();
  instance.isTdsRequestPending = true;

  if(instance.isDebug) {
    console.log('\r\nAttempting database request:');
    console.log(requestString);
  }

  let request = new Request(requestString, (err, rowCount, rows) => {
    if(err) {
      handleError(err, 'Database request failed');
    }

    let isMoreTdsRequests = (instance.tdsRequestStrings.length > 0);

    if(isMoreTdsRequests) {
      return tdsRequest(instance);
    }
    else {
      instance.isTdsRequestPending = false;
    }
  });

  instance.connection.execSql(request);
}


/**
 * Handle the given error by printing a message to the console.
 * @param {Error} error The error.
 * @param {String} description An optional description.
 * @return {Object} The sensor data as JSON.
 */
function handleError(error, description) {
  if(description) {
    console.log('\r\n' + description + ':\r\n' +
                '-----------------------------------------------------------');
  }
  console.log(error);
}


module.exports = AmbientDataTDS;
