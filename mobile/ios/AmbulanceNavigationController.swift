import AudioToolbox
import CoreLocation
import GoogleMaps
import GoogleNavigation
import UIKit

final class AmbulanceNavigationController: NSObject {
  private let mapView: GMSMapView
  private let socket: AmbulanceEventSocket
  private let alertBanner: NavigationAlertBanner
  private let onRerouteSuggested: ((AmbulanceAlertEvent) -> Void)?
  private var markers: [String: GMSMarker] = [:]

  init(
    mapView: GMSMapView,
    socket: AmbulanceEventSocket,
    alertBanner: NavigationAlertBanner,
    onRerouteSuggested: ((AmbulanceAlertEvent) -> Void)? = nil
  ) {
    self.mapView = mapView
    self.socket = socket
    self.alertBanner = alertBanner
    self.onRerouteSuggested = onRerouteSuggested
    super.init()

    self.mapView.isNavigationEnabled = true
    self.mapView.cameraMode = .following

    socket.onMarker = { [weak self] event in
      self?.updateMarker(event: event)
    }

    socket.onAlert = { [weak self] event in
      self?.alertBanner.show(
        message: event.message,
        distanceMeters: event.distanceMeters,
        severity: event.severity
      )
      self?.playSafetyCue()
      if event.rerouteSuggestion != nil {
        self?.onRerouteSuggested?(event)
      }
    }
  }

  func startRoute(placeID: String, title: String) {
    let waypoint = GMSNavigationWaypoint(placeID: placeID, title: title)
    mapView.navigator?.setDestinations([waypoint].compactMap { $0 }) { [weak self] routeStatus in
      guard routeStatus == .ok else { return }
      self?.mapView.navigator?.isGuidanceActive = true
      self?.mapView.navigator?.sendsBackgroundNotifications = true
    }
  }

  func registerDriverRoute(
    sessionId: String,
    driverId: String,
    pushToken: String?,
    location: CLLocationCoordinate2D,
    heading: CLLocationDirection?,
    speedMps: CLLocationSpeed?,
    routePolyline: [CLLocationCoordinate2D]
  ) {
    socket.registerRoute(
      sessionId: sessionId,
      driverId: driverId,
      appState: "foreground",
      pushToken: pushToken,
      location: location,
      heading: heading,
      speedMps: speedMps,
      routeId: "current-nav-route",
      routePolyline: routePolyline
    )
  }

  private func updateMarker(event: AmbulanceMarkerEvent) {
    let coordinate = CLLocationCoordinate2D(
      latitude: event.position.lat,
      longitude: event.position.lng
    )
    let marker = markers[event.ambulanceId] ?? makeMarker(coordinate: coordinate, status: event.status)
    markers[event.ambulanceId] = marker

    CATransaction.begin()
    CATransaction.setAnimationDuration(0.9)
    marker.position = coordinate
    marker.rotation = event.position.heading ?? marker.rotation
    marker.snippet = event.status
    CATransaction.commit()
  }

  private func makeMarker(
    coordinate: CLLocationCoordinate2D,
    status: String
  ) -> GMSMarker {
    if mapView.mapCapabilities.contains(.advancedMarkers) {
      let marker = GMSAdvancedMarker(position: coordinate)
      marker.title = "Ambulance"
      marker.snippet = status
      marker.map = mapView
      return marker
    }

    let marker = GMSMarker(position: coordinate)
    marker.title = "Ambulance"
    marker.snippet = status
    marker.icon = GMSMarker.markerImage(with: .systemRed)
    marker.map = mapView
    return marker
  }

  private func playSafetyCue() {
    AudioServicesPlaySystemSound(1057)
  }
}
