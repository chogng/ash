use super::*;
use std::thread;
use std::time::Duration;

#[test]
fn byte_leases_release_on_completion_and_control_has_independent_capacity() {
    let budgets = InputBudgets {
        ordinary: MessageBudget::new(8),
        control: MessageBudget::new(4),
        host_replies: MessageBudget::new(8),
    };
    let ordinary = budgets.ordinary.try_reserve(8).unwrap();
    assert!(budgets.ordinary.try_reserve(1).is_none());
    let control = budgets.control.try_reserve(4).unwrap();
    let reply = budgets.host_replies.try_reserve(8).unwrap();
    assert!(budgets.control.try_reserve(1).is_none());
    drop(ordinary);
    assert!(budgets.ordinary.try_reserve(8).is_some());
    drop((control, reply));
    assert!(budgets.control.try_reserve(4).is_some());
    assert!(budgets.host_replies.try_reserve(8).is_some());
}

#[test]
fn output_bytes_remain_reserved_during_write_and_writer_close_wakes_producers() {
    let (sender, receiver) = mpsc::sync_channel(4);
    let budget = MessageBudget::new(8);
    let sender = OutboundSender {
        sender,
        budget: budget.clone(),
    };
    let receiver = OutboundReceiver {
        receiver,
        budget: budget.clone(),
    };
    sender.send("12345678".to_owned().into()).unwrap();
    let writing = receiver.recv().unwrap();
    assert!(budget.try_reserve(1).is_none());
    let (started, ready) = mpsc::channel();
    let (finished, result) = mpsc::channel();
    let writer = thread::spawn(move || {
        started.send(()).unwrap();
        finished.send(sender.send("x".to_owned().into())).unwrap();
    });
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(result.try_recv().is_err());
    drop(receiver);
    assert_eq!(
        result
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap_err()
            .kind(),
        io::ErrorKind::BrokenPipe
    );
    drop(writing);
    writer.join().unwrap();
}
