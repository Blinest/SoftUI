#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameHead {
    Motor,
    Sensor,
}

impl FrameHead {
    fn byte(self) -> u8 {
        match self {
            Self::Motor => 0xAA,
            Self::Sensor => 0xBB,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidHeader,
    InvalidLength,
    InvalidChecksum,
    ValueOutOfRange(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub struct MotorData {
    pub position_mm: f64,
    pub velocity_mm_per_sec: f64,
    pub acceleration_mm_per_sec2: f64,
    pub status: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SensorData {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceStatus {
    pub num_motors: u8,
    pub num_sensors: u8,
    pub motors: Vec<MotorData>,
    pub sensors: Vec<SensorData>,
    pub bend_angle1_deg: f64,
    pub bend_angle2_deg: f64,
    pub system_state: u8,
}

#[derive(Debug, Default)]
pub struct LegacyV1Codec {
    buffer: Vec<u8>,
}

impl LegacyV1Codec {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_bytes(&mut self, input: &[u8]) -> Vec<Result<DeviceStatus, ProtocolError>> {
        self.buffer.extend_from_slice(input);
        if self.buffer.len() > 4096 {
            let keep_from = self.buffer.len().saturating_sub(2048);
            self.buffer.drain(..keep_from);
        }

        let mut decoded = Vec::new();
        let mut index = 0usize;

        while index + 3 <= self.buffer.len() {
            if self.buffer[index] != 0xBB || self.buffer[index + 1] != 0x02 {
                index += 1;
                continue;
            }

            let total_len = self.buffer[index + 2] as usize;
            let frame_len = total_len + 4;
            if index + frame_len > self.buffer.len() {
                break;
            }

            let frame = self.buffer[index..index + frame_len].to_vec();
            match parse_status_frame(&frame) {
                Ok(status) => {
                    decoded.push(Ok(status));
                    index += frame_len;
                }
                Err(ProtocolError::InvalidChecksum) => {
                    decoded.push(Err(ProtocolError::InvalidChecksum));
                    index += 1;
                }
                Err(error) => {
                    decoded.push(Err(error));
                    index += frame_len;
                }
            }
        }

        if index > 0 {
            self.buffer.drain(..index);
        }

        decoded
    }
}

pub fn encode_frame(head: FrameHead, function: u8, data: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let len = u8::try_from(data.len()).map_err(|_| ProtocolError::InvalidLength)?;
    let mut frame = Vec::with_capacity(data.len() + 4);
    frame.push(head.byte());
    frame.push(function);
    frame.push(len);
    frame.extend_from_slice(data);
    frame.push(checksum(&frame));
    Ok(frame)
}

pub fn encode_motor_command(
    motor_id: u8,
    position_mm: f64,
    velocity_mm_per_sec: f64,
    acceleration_mm_per_sec2: f64,
) -> Result<Vec<u8>, ProtocolError> {
    let direction = if position_mm >= 0.0 { 0 } else { 1 };
    let distance = scaled_u16(position_mm.abs(), "position")?;
    let velocity = scaled_u16(velocity_mm_per_sec, "velocity")?;
    let acceleration = scaled_u16(acceleration_mm_per_sec2, "acceleration")?;

    let mut data = Vec::with_capacity(8);
    data.push(motor_id);
    data.push(direction);
    data.extend_from_slice(&distance.to_be_bytes());
    data.extend_from_slice(&velocity.to_be_bytes());
    data.extend_from_slice(&acceleration.to_be_bytes());
    encode_frame(FrameHead::Motor, 0x03, &data)
}

pub fn encode_system_control_command(
    action: SystemControlAction,
) -> Result<Vec<u8>, ProtocolError> {
    encode_frame(FrameHead::Motor, action.function_code(), &[])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemControlAction {
    Disable,
    Enable,
    EmergencyStop,
}

impl SystemControlAction {
    pub fn function_code(self) -> u8 {
        match self {
            Self::Disable => 0x00,
            Self::Enable => 0x01,
            Self::EmergencyStop => 0x02,
        }
    }
}

pub fn encode_sensor_calibration(
    sensor_id: u8,
    calibration_value: f64,
) -> Result<Vec<u8>, ProtocolError> {
    let raw = (calibration_value * 100.0)
        .trunc()
        .clamp(i16::MIN as f64, i16::MAX as f64) as i16;
    let mut data = Vec::with_capacity(3);
    data.push(sensor_id);
    data.extend_from_slice(&raw.to_be_bytes());
    encode_frame(FrameHead::Sensor, 0x03, &data)
}

pub fn encode_home_command(motor_count: u8, start_address: u8) -> Result<Vec<u8>, ProtocolError> {
    let mut data = Vec::with_capacity(2 + motor_count as usize * 2);
    data.push(motor_count);
    data.push(start_address);
    for _ in 0..motor_count {
        data.extend_from_slice(&0u16.to_be_bytes());
    }
    encode_frame(FrameHead::Motor, 0x04, &data)
}

pub fn encode_bend_command(
    direction1: u8,
    angle1_deg: f64,
    direction2: u8,
    angle2_deg: f64,
) -> Result<Vec<u8>, ProtocolError> {
    if direction1 > 3 || direction2 > 3 {
        return Err(ProtocolError::ValueOutOfRange("direction"));
    }

    let angle1 = scaled_u16(angle1_deg.abs(), "angle1")?;
    let angle2 = scaled_u16(angle2_deg.abs(), "angle2")?;
    let mut data = Vec::with_capacity(6);
    data.push(direction1);
    data.extend_from_slice(&angle1.to_be_bytes());
    data.push(direction2);
    data.extend_from_slice(&angle2.to_be_bytes());
    encode_frame(FrameHead::Motor, 0x05, &data)
}

pub fn encode_active_control_tick() -> Vec<u8> {
    let mut frame = vec![0xAA, 0x06, 0x02, 0x02, 0x00];
    frame.push(checksum(&frame));
    frame
}

pub fn encode_status_frame(status: &DeviceStatus) -> Result<Vec<u8>, ProtocolError> {
    if status.motors.len() > u8::MAX as usize || status.sensors.len() > u8::MAX as usize {
        return Err(ProtocolError::InvalidLength);
    }
    if status.motors.len() != status.num_motors as usize
        || status.sensors.len() != status.num_sensors as usize
    {
        return Err(ProtocolError::InvalidLength);
    }

    let total_len = 1 + 1 + status.motors.len() * 7 + status.sensors.len() * 12 + 2 + 2 + 1;
    let total_len = u8::try_from(total_len).map_err(|_| ProtocolError::InvalidLength)?;
    let mut frame = Vec::with_capacity(total_len as usize + 4);
    frame.extend_from_slice(&[0xBB, 0x02, total_len, status.num_motors, status.num_sensors]);

    for motor in &status.motors {
        frame.extend_from_slice(&scaled_i16(motor.position_mm, "position")?.to_be_bytes());
        frame.extend_from_slice(&scaled_i16(motor.velocity_mm_per_sec, "velocity")?.to_be_bytes());
        frame.extend_from_slice(
            &scaled_i16(motor.acceleration_mm_per_sec2, "acceleration")?.to_be_bytes(),
        );
        frame.push(motor.status);
    }

    for sensor in &status.sensors {
        frame.extend_from_slice(&raw_i32(sensor.x, "sensor_x")?.to_be_bytes());
        frame.extend_from_slice(&raw_i32(sensor.y, "sensor_y")?.to_be_bytes());
        frame.extend_from_slice(&raw_i32(sensor.z, "sensor_z")?.to_be_bytes());
    }

    frame.extend_from_slice(&scaled_i16(status.bend_angle1_deg, "bend_angle1")?.to_be_bytes());
    frame.extend_from_slice(&scaled_i16(status.bend_angle2_deg, "bend_angle2")?.to_be_bytes());
    frame.push(status.system_state);
    frame.push(checksum(&frame));
    Ok(frame)
}

pub fn parse_status_frame(frame: &[u8]) -> Result<DeviceStatus, ProtocolError> {
    if frame.len() < 4 || frame[0] != 0xBB || frame[1] != 0x02 {
        return Err(ProtocolError::InvalidHeader);
    }

    let total_len = frame[2] as usize;
    if frame.len() != total_len + 4 {
        return Err(ProtocolError::InvalidLength);
    }

    let expected_checksum = checksum(&frame[..frame.len() - 1]);
    if frame[frame.len() - 1] != expected_checksum {
        return Err(ProtocolError::InvalidChecksum);
    }

    let num_motors = frame[3];
    let num_sensors = frame[4];
    let expected_data_len = 1 + 1 + num_motors as usize * 7 + num_sensors as usize * 12 + 2 + 2 + 1;
    if total_len != expected_data_len {
        return Err(ProtocolError::InvalidLength);
    }

    let mut offset = 5usize;
    let mut motors = Vec::with_capacity(num_motors as usize);
    for _ in 0..num_motors {
        let position = read_i16(frame, &mut offset)? as f64 / 100.0;
        let velocity = read_i16(frame, &mut offset)? as f64 / 100.0;
        let acceleration = read_i16(frame, &mut offset)? as f64 / 100.0;
        let status = read_u8(frame, &mut offset)?;
        motors.push(MotorData {
            position_mm: position,
            velocity_mm_per_sec: velocity,
            acceleration_mm_per_sec2: acceleration,
            status,
        });
    }

    let mut sensors = Vec::with_capacity(num_sensors as usize);
    for _ in 0..num_sensors {
        sensors.push(SensorData {
            x: read_i32(frame, &mut offset)? as f64,
            y: read_i32(frame, &mut offset)? as f64,
            z: read_i32(frame, &mut offset)? as f64,
        });
    }

    let bend_angle1_deg = read_i16(frame, &mut offset)? as f64 / 100.0;
    let bend_angle2_deg = read_i16(frame, &mut offset)? as f64 / 100.0;
    let system_state = read_u8(frame, &mut offset)?;

    if offset != frame.len() - 1 {
        return Err(ProtocolError::InvalidLength);
    }

    Ok(DeviceStatus {
        num_motors,
        num_sensors,
        motors,
        sensors,
        bend_angle1_deg,
        bend_angle2_deg,
        system_state,
    })
}

fn checksum(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0u8, |sum, byte| sum.wrapping_add(*byte))
}

fn scaled_u16(value: f64, field: &'static str) -> Result<u16, ProtocolError> {
    if !value.is_finite() || value < 0.0 {
        return Err(ProtocolError::ValueOutOfRange(field));
    }
    let scaled = (value * 100.0).trunc();
    if scaled > u16::MAX as f64 {
        return Err(ProtocolError::ValueOutOfRange(field));
    }
    Ok(scaled as u16)
}

fn scaled_i16(value: f64, field: &'static str) -> Result<i16, ProtocolError> {
    if !value.is_finite() {
        return Err(ProtocolError::ValueOutOfRange(field));
    }
    let scaled = (value * 100.0).trunc();
    if scaled < i16::MIN as f64 || scaled > i16::MAX as f64 {
        return Err(ProtocolError::ValueOutOfRange(field));
    }
    Ok(scaled as i16)
}

fn raw_i32(value: f64, field: &'static str) -> Result<i32, ProtocolError> {
    if !value.is_finite() || value < i32::MIN as f64 || value > i32::MAX as f64 {
        return Err(ProtocolError::ValueOutOfRange(field));
    }
    Ok(value.trunc() as i32)
}

fn read_u8(frame: &[u8], offset: &mut usize) -> Result<u8, ProtocolError> {
    let value = *frame.get(*offset).ok_or(ProtocolError::InvalidLength)?;
    *offset += 1;
    Ok(value)
}

fn read_i16(frame: &[u8], offset: &mut usize) -> Result<i16, ProtocolError> {
    if *offset + 2 > frame.len() {
        return Err(ProtocolError::InvalidLength);
    }
    let value = i16::from_be_bytes([frame[*offset], frame[*offset + 1]]);
    *offset += 2;
    Ok(value)
}

fn read_i32(frame: &[u8], offset: &mut usize) -> Result<i32, ProtocolError> {
    if *offset + 4 > frame.len() {
        return Err(ProtocolError::InvalidLength);
    }
    let value = i32::from_be_bytes([
        frame[*offset],
        frame[*offset + 1],
        frame[*offset + 2],
        frame[*offset + 3],
    ]);
    *offset += 4;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn append_checksum(mut frame: Vec<u8>) -> Vec<u8> {
        frame.push(checksum(&frame));
        frame
    }

    fn sample_status_frame() -> Vec<u8> {
        append_checksum(vec![
            0xBB, 0x02, 0x1A, 0x01, 0x01, 0x04, 0xD2, 0xFF, 0x06, 0x00, 0x64, 0x01, 0x00, 0x01,
            0x86, 0xA0, 0xFF, 0xFC, 0xF2, 0xC0, 0x00, 0x04, 0x93, 0xE0, 0x04, 0xD2, 0xFD, 0xC9,
            0x01,
        ])
    }

    #[test]
    fn parses_legacy_status_frame() {
        let status = parse_status_frame(&sample_status_frame()).expect("status frame");

        assert_eq!(status.num_motors, 1);
        assert_eq!(status.num_sensors, 1);
        assert_eq!(status.motors[0].position_mm, 12.34);
        assert_eq!(status.motors[0].velocity_mm_per_sec, -2.5);
        assert_eq!(status.motors[0].acceleration_mm_per_sec2, 1.0);
        assert_eq!(status.motors[0].status, 1);
        assert_eq!(status.sensors[0].x, 100000.0);
        assert_eq!(status.sensors[0].y, -200000.0);
        assert_eq!(status.sensors[0].z, 300000.0);
        assert_eq!(status.bend_angle1_deg, 12.34);
        assert_eq!(status.bend_angle2_deg, -5.67);
        assert_eq!(status.system_state, 1);
    }

    #[test]
    fn stream_parser_handles_fragmented_frames() {
        let frame = sample_status_frame();
        let mut parser = LegacyV1Codec::new();

        assert!(parser.push_bytes(&frame[..8]).is_empty());
        let decoded = parser.push_bytes(&frame[8..]);

        assert_eq!(decoded.len(), 1);
        assert!(decoded[0].as_ref().is_ok());
    }

    #[test]
    fn stream_parser_resynchronizes_after_bad_checksum() {
        let mut bad = sample_status_frame();
        let last = bad.len() - 1;
        bad[last] = bad[last].wrapping_add(1);

        let mut input = bad;
        input.extend_from_slice(&sample_status_frame());
        let mut parser = LegacyV1Codec::new();
        let decoded = parser.push_bytes(&input);

        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0], Err(ProtocolError::InvalidChecksum));
        assert!(decoded[1].as_ref().is_ok());
    }

    #[test]
    fn encodes_motor_command_like_legacy_python() {
        let frame = encode_motor_command(1, -7.0, 10.0, 10.0).expect("motor command");
        assert_eq!(
            frame,
            vec![0xAA, 0x03, 0x08, 0x01, 0x01, 0x02, 0xBC, 0x03, 0xE8, 0x03, 0xE8, 0x4B]
        );
    }

    #[test]
    fn encodes_system_control_commands_like_legacy_python() {
        assert_eq!(
            encode_system_control_command(SystemControlAction::Disable).expect("disable"),
            vec![0xAA, 0x00, 0x00, 0xAA]
        );
        assert_eq!(
            encode_system_control_command(SystemControlAction::Enable).expect("enable"),
            vec![0xAA, 0x01, 0x00, 0xAB]
        );
        assert_eq!(
            encode_system_control_command(SystemControlAction::EmergencyStop)
                .expect("emergency stop"),
            vec![0xAA, 0x02, 0x00, 0xAC]
        );
    }

    #[test]
    fn encodes_sensor_calibration_like_legacy_python() {
        let frame = encode_sensor_calibration(2, -3.25).expect("sensor calibration");
        assert_eq!(frame, vec![0xBB, 0x03, 0x03, 0x02, 0xFE, 0xBB, 0x7C]);
    }

    #[test]
    fn encodes_bend_and_active_control_frames() {
        let bend = encode_bend_command(0, 12.34, 3, 56.78).expect("bend command");
        assert_eq!(
            bend,
            vec![0xAA, 0x05, 0x06, 0x00, 0x04, 0xD2, 0x03, 0x16, 0x2E, 0xD2]
        );
        assert_eq!(
            encode_active_control_tick(),
            vec![0xAA, 0x06, 0x02, 0x02, 0x00, 0xB4]
        );
    }

    #[test]
    fn encodes_status_frame_for_simulator_round_trip() {
        let status = DeviceStatus {
            num_motors: 1,
            num_sensors: 1,
            motors: vec![MotorData {
                position_mm: -1.25,
                velocity_mm_per_sec: 8.5,
                acceleration_mm_per_sec2: 2.75,
                status: 1,
            }],
            sensors: vec![SensorData {
                x: 123.0,
                y: -456.0,
                z: 789.0,
            }],
            bend_angle1_deg: 12.5,
            bend_angle2_deg: -6.75,
            system_state: 1,
        };

        let frame = encode_status_frame(&status).expect("status frame");
        let parsed = parse_status_frame(&frame).expect("parsed status");

        assert_eq!(parsed, status);
    }
}
