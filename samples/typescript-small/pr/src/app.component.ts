import { GreetingService } from "./greeting.service";

export class AppComponent {
  private service = new GreetingService();

  run(): number {
    return this.service.computeTotal(2, 3);
  }

  display(): string {
    return this.service.formattedTotal(2, 3);
  }
}
