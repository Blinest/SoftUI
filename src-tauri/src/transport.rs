use std::{
    collections::VecDeque,
    io::{Read, Write},
    time::Duration,
};

use crate::protocol::{self, DeviceStatus, ProtocolError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    Closed,
    Io(String),
    Protocol(ProtocolError),
    Serial(String),
}

impl TransportError {
    pub fn code(&self) -> &'static str {
        match self {
            TransportError::Closed => "SERIAL_CLOSED",
            TransportError::Io(_) => "SERIAL_IO",
            TransportError::Protocol(_) => "PROTOCOL_FRAME",
            TransportError::Serial(_) => "SERIAL_OPEN",
        }
    }
}

impl From<ProtocolError> for TransportError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(value)
    }
}

pub trait Transport: Send + 'static {
    fn read(&mut self) -> Result<Vec<u8>, TransportError>;
    fn write(&mut self, bytes: &[u8]) -> Result<(), TransportError>;
    fn close(&mut self) -> Result<(), TransportError>;
}

impl<T: Transport + ?Sized> Transport for Box<T> {
    fn read(&mut self) -> Result<Vec<u8>, TransportError> {
        (**self).read()
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
        (**self).write(bytes)
    }

    fn close(&mut self) -> Result<(), TransportError> {
        (**self).close()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortDescriptor {
    pub port_name: String,
    pub port_type: String,
    pub description: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub likely_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerialConnectionConfig {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
    pub flow_control: String,
    pub timeout_ms: u64,
}

impl SerialConnectionConfig {
    pub fn legacy_default(port_name: impl Into<String>) -> Self {
        Self {
            port_name: port_name.into(),
            baud_rate: 9_600,
            data_bits: 8,
            parity: "none".to_string(),
            stop_bits: 1,
            flow_control: "none".to_string(),
            timeout_ms: 50,
        }
    }
}

pub fn list_serial_ports() -> Result<Vec<SerialPortDescriptor>, TransportError> {
    let ports = serialport::available_ports()
        .map_err(|error| TransportError::Serial(format!("failed to list serial ports: {error}")))?;
    Ok(ports
        .into_iter()
        .map(serial_port_descriptor_from_info)
        .collect())
}

fn serial_port_descriptor_from_info(info: serialport::SerialPortInfo) -> SerialPortDescriptor {
    match info.port_type {
        serialport::SerialPortType::UsbPort(usb) => SerialPortDescriptor {
            port_name: info.port_name,
            port_type: "usb".to_string(),
            description: usb.product.clone(),
            manufacturer: usb.manufacturer,
            product: usb.product,
            serial_number: usb.serial_number,
            vid: Some(usb.vid),
            pid: Some(usb.pid),
            likely_available: true,
        },
        serialport::SerialPortType::BluetoothPort => SerialPortDescriptor {
            port_name: info.port_name,
            port_type: "bluetooth".to_string(),
            description: Some("Bluetooth serial port".to_string()),
            manufacturer: None,
            product: None,
            serial_number: None,
            vid: None,
            pid: None,
            likely_available: false,
        },
        serialport::SerialPortType::PciPort => SerialPortDescriptor {
            port_name: info.port_name,
            port_type: "pci".to_string(),
            description: Some("PCI serial port".to_string()),
            manufacturer: None,
            product: None,
            serial_number: None,
            vid: None,
            pid: None,
            likely_available: true,
        },
        serialport::SerialPortType::Unknown => SerialPortDescriptor {
            port_name: info.port_name,
            port_type: "unknown".to_string(),
            description: None,
            manufacturer: None,
            product: None,
            serial_number: None,
            vid: None,
            pid: None,
            likely_available: true,
        },
    }
}

pub struct SerialTransport {
    config: SerialConnectionConfig,
    port: Option<Box<dyn serialport::SerialPort>>,
}

impl SerialTransport {
    pub fn open(config: SerialConnectionConfig) -> Result<Self, TransportError> {
        let data_bits = match config.data_bits {
            8 => serialport::DataBits::Eight,
            7 => serialport::DataBits::Seven,
            _ => {
                return Err(TransportError::Serial(format!(
                    "unsupported data bits: {}",
                    config.data_bits
                )));
            }
        };

        let parity = match config.parity.as_str() {
            "none" => serialport::Parity::None,
            "even" => serialport::Parity::Even,
            "odd" => serialport::Parity::Odd,
            _ => {
                return Err(TransportError::Serial(format!(
                    "unsupported parity: {}",
                    config.parity
                )));
            }
        };

        let stop_bits = match config.stop_bits {
            1 => serialport::StopBits::One,
            2 => serialport::StopBits::Two,
            _ => {
                return Err(TransportError::Serial(format!(
                    "unsupported stop bits: {}",
                    config.stop_bits
                )));
            }
        };

        let flow_control = match config.flow_control.as_str() {
            "none" => serialport::FlowControl::None,
            "software" => serialport::FlowControl::Software,
            "hardware" => serialport::FlowControl::Hardware,
            _ => {
                return Err(TransportError::Serial(format!(
                    "unsupported flow control: {}",
                    config.flow_control
                )));
            }
        };

        let port = serialport::new(&config.port_name, config.baud_rate)
            .data_bits(data_bits)
            .parity(parity)
            .stop_bits(stop_bits)
            .flow_control(flow_control)
            .timeout(Duration::from_millis(config.timeout_ms))
            .open()
            .map_err(|error| {
                TransportError::Serial(format!(
                    "failed to open {} at {} baud: {error}",
                    config.port_name, config.baud_rate
                ))
            })?;

        Ok(Self {
            config,
            port: Some(port),
        })
    }

    pub fn config(&self) -> &SerialConnectionConfig {
        &self.config
    }
}

impl Transport for SerialTransport {
    fn read(&mut self) -> Result<Vec<u8>, TransportError> {
        let port = self.port.as_mut().ok_or(TransportError::Closed)?;
        let available = port.bytes_to_read().unwrap_or(0);
        let capacity = if available > 0 {
            available.min(4096) as usize
        } else {
            256
        };
        let mut buffer = vec![0u8; capacity];

        match port.read(&mut buffer) {
            Ok(read_count) => {
                buffer.truncate(read_count);
                Ok(buffer)
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => Ok(Vec::new()),
            Err(error) => Err(TransportError::Io(format!(
                "failed to read from {}: {error}",
                self.config.port_name
            ))),
        }
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
        let port = self.port.as_mut().ok_or(TransportError::Closed)?;
        port.write_all(bytes).map_err(|error| {
            TransportError::Io(format!(
                "failed to write {} bytes to {}: {error}",
                bytes.len(),
                self.config.port_name
            ))
        })?;
        port.flush().map_err(|error| {
            TransportError::Io(format!(
                "failed to flush {}: {error}",
                self.config.port_name
            ))
        })?;
        Ok(())
    }

    fn close(&mut self) -> Result<(), TransportError> {
        self.port.take();
        Ok(())
    }
}

#[derive(Debug)]
pub struct SimulatorTransport {
    closed: bool,
    sequence: u64,
    pending_reads: VecDeque<Vec<u8>>,
    writes: Vec<Vec<u8>>,
}

impl SimulatorTransport {
    pub fn new() -> Result<Self, TransportError> {
        Self::with_seed(0)
    }

    pub fn with_seed(sequence: u64) -> Result<Self, TransportError> {
        let mut transport = Self {
            closed: false,
            sequence,
            pending_reads: VecDeque::new(),
            writes: Vec::new(),
        };
        transport.enqueue_next_status()?;
        Ok(transport)
    }

    pub fn written_frames(&self) -> &[Vec<u8>] {
        &self.writes
    }

    fn enqueue_next_status(&mut self) -> Result<(), TransportError> {
        let status = simulated_status(self.sequence);
        self.sequence = self.sequence.saturating_add(1);
        self.pending_reads
            .push_back(protocol::encode_status_frame(&status)?);
        Ok(())
    }
}

impl Transport for SimulatorTransport {
    fn read(&mut self) -> Result<Vec<u8>, TransportError> {
        if self.closed {
            return Err(TransportError::Closed);
        }

        if self.pending_reads.is_empty() {
            self.enqueue_next_status()?;
        }

        Ok(self.pending_reads.pop_front().unwrap_or_default())
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
        if self.closed {
            return Err(TransportError::Closed);
        }
        self.writes.push(bytes.to_vec());
        self.enqueue_next_status()?;
        Ok(())
    }

    fn close(&mut self) -> Result<(), TransportError> {
        self.closed = true;
        Ok(())
    }
}

fn simulated_status(sequence: u64) -> DeviceStatus {
    let motors = (0..6)
        .map(|index| {
            let phase = sequence as f64 / 8.0 + index as f64 * 0.7;
            protocol::MotorData {
                position_mm: 24.0 + phase.sin() * 7.0 + index as f64 * 0.8,
                velocity_mm_per_sec: 8.0 + phase.cos() * 2.2,
                acceleration_mm_per_sec2: 2.2 + (phase * 0.8).sin().abs() * 1.8,
                status: 1,
            }
        })
        .collect::<Vec<_>>();

    let sensors = (0..6)
        .map(|index| {
            let phase = sequence as f64 / 5.0 + index as f64;
            protocol::SensorData {
                x: 32.0 + phase.sin() * 3.2,
                y: 18.0 + phase.cos() * 2.1,
                z: 11.5 + (phase * 0.7).sin() * 1.4,
            }
        })
        .collect::<Vec<_>>();

    DeviceStatus {
        num_motors: motors.len() as u8,
        num_sensors: sensors.len() as u8,
        motors,
        sensors,
        bend_angle1_deg: (sequence as f64 / 6.0).sin() * 46.8 + 15.6,
        bend_angle2_deg: (sequence as f64 / 6.0 + 0.6).sin() * 38.4 + 12.8,
        system_state: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{encode_motor_command, parse_status_frame};
    use serialport::{SerialPortInfo, SerialPortType, UsbPortInfo};

    #[test]
    fn simulator_read_returns_legacy_status_frame() {
        let mut transport = SimulatorTransport::with_seed(12).expect("simulator");

        let bytes = transport.read().expect("read");
        let status = parse_status_frame(&bytes).expect("status");

        assert_eq!(status.num_motors, 6);
        assert_eq!(status.num_sensors, 6);
        assert_eq!(status.system_state, 1);
    }

    #[test]
    fn simulator_records_written_command_and_generates_followup_status() {
        let mut transport = SimulatorTransport::new().expect("simulator");
        let command = encode_motor_command(1, 5.0, 10.0, 3.0).expect("command");

        transport.write(&command).expect("write");
        let status = parse_status_frame(&transport.read().expect("read")).expect("status");

        assert_eq!(transport.written_frames(), &[command]);
        assert_eq!(status.num_motors, 6);
    }

    #[test]
    fn simulator_rejects_io_after_close() {
        let mut transport = SimulatorTransport::new().expect("simulator");
        transport.close().expect("close");

        assert_eq!(transport.read(), Err(TransportError::Closed));
        assert_eq!(transport.write(&[0xAA]), Err(TransportError::Closed));
    }

    #[test]
    fn maps_usb_serial_port_descriptor() {
        let descriptor = serial_port_descriptor_from_info(SerialPortInfo {
            port_name: "COM7".to_string(),
            port_type: SerialPortType::UsbPort(UsbPortInfo {
                vid: 0x1234,
                pid: 0x5678,
                serial_number: Some("SN001".to_string()),
                manufacturer: Some("SoftUI Lab".to_string()),
                product: Some("Continuum Controller".to_string()),
            }),
        });

        assert_eq!(descriptor.port_name, "COM7");
        assert_eq!(descriptor.port_type, "usb");
        assert_eq!(
            descriptor.description.as_deref(),
            Some("Continuum Controller")
        );
        assert_eq!(descriptor.vid, Some(0x1234));
        assert!(descriptor.likely_available);
    }

    #[test]
    fn maps_bluetooth_serial_port_as_unlikely_for_robot() {
        let descriptor = serial_port_descriptor_from_info(SerialPortInfo {
            port_name: "COM9".to_string(),
            port_type: SerialPortType::BluetoothPort,
        });

        assert_eq!(descriptor.port_type, "bluetooth");
        assert!(!descriptor.likely_available);
    }
}
